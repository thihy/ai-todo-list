// AI composer inbox — copy/blob → 磁盘 + sidecar JSON 索引 + 清理。
//
// 关键不变量（每个测试断言其中一两条）：
//   1. copyPathToInbox / writeBlobToInbox 都创建文件 + 写索引条目
//   2. 重名 basename 通过 ulid suffix 区分，索引按 convId 分组
//   3. relinkDraft 把 draft 期间挂的路径挪到正式 convId 下
//   4. cleanupForConv 删物理文件 + 删索引条目，幂等
//   5. 索引写是 mutex 串行的 —— 并发 commit 不丢条目
//   6. 索引损坏 / 不存在 → loadIndex 走空索引路径，不抛错
//   7. 大文件（>1MB）完整写入，不截断

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupForConv,
  copyPathToInbox,
  initComposerInbox,
  listPathsForConv,
  relinkDraft,
  _resetForTests,
  writeBlobToInbox,
} from '../../src/main/ai/composer-inbox';

describe('ai/composer-inbox', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'todo-list-composer-inbox-'));
    _resetForTests();
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    _resetForTests();
  });

  describe('copyPathToInbox', () => {
    it('copies a small file and registers it under the conv key', async () => {
      const src = join(rootDir, 'source.txt');
      writeFileSync(src, 'hello world');
      const result = await copyPathToInbox(rootDir, src, 'greeting.txt', 'text/plain', 'conv-1');
      // 返回 path 指向 inbox 目录，且包含 convId + ulid + basename
      expect(result.path).toContain('dsh_workspace');
      expect(result.path).toContain('inbox');
      expect(result.path).toContain('c-conv-1-');
      expect(result.path).toMatch(/greeting\.txt$/);
      expect(result.name).toBe('greeting.txt');
      expect(result.mime).toBe('text/plain');
      expect(result.size).toBe(11);
      // 文件实际写到了磁盘
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, 'utf8')).toBe('hello world');
      // 索引里有了这条
      expect(listPathsForConv(rootDir, 'conv-1')).toEqual([result.path]);
    });

    it('uses "draft" as the placeholder key when conversationId is null', async () => {
      const src = join(rootDir, 'source.png');
      // 假装 PNG 头字节
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      writeFileSync(src, buf);
      const result = await copyPathToInbox(rootDir, src, 'shot.png', 'image/png', null);
      expect(result.path).toMatch(/c-draft-[A-Z0-9]+-shot\.png$/);
      // draft key 落到 listPathsForConv 拿不到（只查 'conv-1'），但
      // relinkDraft 能看到 —— 直接通过读 sidecar index 验证。
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      expect(idx.conversations.draft).toContain(result.path);
    });

    it('disambiguates same-name files via ulid suffix', async () => {
      const src1 = join(rootDir, 'a.txt');
      const src2 = join(rootDir, 'b.txt');
      writeFileSync(src1, 'first');
      writeFileSync(src2, 'second');
      const r1 = await copyPathToInbox(rootDir, src1, 'note.txt', 'text/plain', 'conv-A');
      const r2 = await copyPathToInbox(rootDir, src2, 'note.txt', 'text/plain', 'conv-A');
      // 两条路径不同（basename 前缀的 ulid 不同）
      expect(r1.path).not.toBe(r2.path);
      // 两份内容都正确
      expect(readFileSync(r1.path, 'utf8')).toBe('first');
      expect(readFileSync(r2.path, 'utf8')).toBe('second');
      // 索引里两条都在
      expect(listPathsForConv(rootDir, 'conv-A').sort()).toEqual([r1.path, r2.path].sort());
    });

    it('preserves bytes for large files (>1 MiB)', async () => {
      const big = Buffer.alloc(2 * 1024 * 1024, 0x42);
      const src = join(rootDir, 'big.bin');
      writeFileSync(src, big);
      const result = await copyPathToInbox(rootDir, src, 'big.bin', 'application/octet-stream', 'conv-big');
      expect(result.size).toBe(big.length);
      const back = readFileSync(result.path);
      expect(back.length).toBe(big.length);
      expect(back.equals(big)).toBe(true);
    });
  });

  describe('writeBlobToInbox', () => {
    it('writes a Buffer and registers it', async () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI + APP0 头字节
      const result = await writeBlobToInbox(rootDir, 'snapshot.jpg', 'image/jpeg', buf, 'conv-jpg');
      expect(result.size).toBe(buf.length);
      expect(readFileSync(result.path).equals(buf)).toBe(true);
      expect(listPathsForConv(rootDir, 'conv-jpg')).toEqual([result.path]);
    });

    it('accepts Uint8Array in addition to Buffer', async () => {
      const u8 = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await writeBlobToInbox(rootDir, 'tiny.bin', 'application/octet-stream', u8, 'conv-u8');
      expect(result.size).toBe(5);
      expect(readFileSync(result.path)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    });
  });

  describe('relinkDraft', () => {
    it('moves paths from "draft" key to a real convId', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'draft data');
      const drafted = await copyPathToInbox(rootDir, src, 'a.txt', 'text/plain', null);
      // listPathsForConv 查任意 id（包括 'draft' 本身）都能从 sidecar 拿。
      // 这里先断言 'draft' key 下有这条 —— 下一段再 relink 后该 key 应为空。
      expect(listPathsForConv(rootDir, 'draft')).toEqual([drafted.path]);
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      // 落地在 draft
      let idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      expect(idx.conversations.draft).toContain(drafted.path);
      // 挪到真实 convId
      await relinkDraft(rootDir, 'conv-real', [drafted.path]);
      idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      expect(idx.conversations.draft ?? []).not.toContain(drafted.path);
      expect(idx.conversations['conv-real']).toContain(drafted.path);
    });

    it('is a no-op for paths not in the draft key', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'x');
      const direct = await copyPathToInbox(rootDir, src, 'x.txt', 'text/plain', 'conv-direct');
      // 尝试把一个非 draft 的路径 relink —— 不应抛错，也不应清掉 conv-direct
      await relinkDraft(rootDir, 'conv-other', [direct.path]);
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      expect(idx.conversations['conv-direct']).toContain(direct.path);
    });

    it('removes the "draft" key when the last path is relinked', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'only');
      const r = await copyPathToInbox(rootDir, src, 'only.txt', 'text/plain', null);
      await relinkDraft(rootDir, 'conv-only', [r.path]);
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      expect(idx.conversations.draft).toBeUndefined();
    });
  });

  describe('cleanupForConv', () => {
    it('removes files on disk and the index entry', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'clean me');
      const result = await copyPathToInbox(rootDir, src, 'gone.txt', 'text/plain', 'conv-clean');
      expect(existsSync(result.path)).toBe(true);
      await cleanupForConv(rootDir, 'conv-clean');
      expect(existsSync(result.path)).toBe(false);
      expect(listPathsForConv(rootDir, 'conv-clean')).toEqual([]);
    });

    it('is idempotent — calling twice does not throw', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'x');
      await copyPathToInbox(rootDir, src, 'x.txt', 'text/plain', 'conv-idem');
      await cleanupForConv(rootDir, 'conv-idem');
      await expect(cleanupForConv(rootDir, 'conv-idem')).resolves.toBeUndefined();
    });

    it('does not touch other conversations', async () => {
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'shared');
      const a = await copyPathToInbox(rootDir, src, 'a.txt', 'text/plain', 'conv-A');
      const b = await copyPathToInbox(rootDir, src, 'b.txt', 'text/plain', 'conv-B');
      await cleanupForConv(rootDir, 'conv-A');
      expect(existsSync(a.path)).toBe(false);
      expect(existsSync(b.path)).toBe(true);
      expect(listPathsForConv(rootDir, 'conv-B')).toEqual([b.path]);
    });
  });

  describe('concurrency', () => {
    it('serial commit does not drop entries', async () => {
      // 8 个 copyPathToInbox 同步触发，8 条全部应该进索引。
      const tasks = Array.from({ length: 8 }, async (_, i) => {
        const src = join(rootDir, `s-${i}.txt`);
        writeFileSync(src, `payload-${i}`);
        return copyPathToInbox(rootDir, src, `f-${i}.txt`, 'text/plain', 'conv-race');
      });
      const results = await Promise.all(tasks);
      const listed = listPathsForConv(rootDir, 'conv-race');
      expect(listed).toHaveLength(8);
      for (const r of results) expect(listed).toContain(r.path);
    });
  });

  describe('index robustness', () => {
    it('returns empty index when sidecar JSON is missing', async () => {
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      // 还没 initComposerInbox，连 sidecar 都没有；listPathsForConv 不应抛错
      expect(listPathsForConv(rootDir, 'conv-x')).toEqual([]);
      // initComposerInbox 只负责 mkdir inbox/；sidecar JSON 只在第一次
      // 落盘（indexForConv / copyPathToInbox 触发）时才生成 —— 这是有意
      // 的，避免一个空的 inbox 目录先写一个空 JSON 占位。
      initComposerInbox(rootDir);
      expect(existsSync(idxPath)).toBe(false);
      // 第一次 copy 之后 sidecar 才会出现
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'first');
      await copyPathToInbox(rootDir, src, 'first.txt', 'text/plain', 'conv-init');
      expect(existsSync(idxPath)).toBe(true);
    });

    it('survives a corrupt sidecar JSON (treats as empty)', async () => {
      initComposerInbox(rootDir);
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      writeFileSync(idxPath, '<<not valid json>>');
      // 不抛错，返回空数组
      expect(listPathsForConv(rootDir, 'conv-z')).toEqual([]);
      // 后续写也能成功
      const src = join(rootDir, 'src.txt');
      writeFileSync(src, 'after-corrupt');
      const r = await copyPathToInbox(rootDir, src, 'a.txt', 'text/plain', 'conv-z');
      expect(listPathsForConv(rootDir, 'conv-z')).toEqual([r.path]);
    });

    it('survives a sidecar JSON with the wrong version', async () => {
      initComposerInbox(rootDir);
      const idxPath = join(rootDir, 'dsh_workspace', 'inbox', '.composer-index.json');
      writeFileSync(idxPath, JSON.stringify({ version: 99, conversations: { 'old': ['/tmp/whatever'] } }));
      // 版本不匹配 → 走空索引，'old' 那条就当丢了（best-effort）
      expect(listPathsForConv(rootDir, 'old')).toEqual([]);
    });
  });
});
