import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MemoStore imports the app logger, which resolves LOG_PATH through
// electron's `app.getPath('userData')` at module load. Mock the logger
// module itself so the store keeps its logging surface without dragging
// Electron into a node-environment test.
vi.mock('../../src/main/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MemoStore, derivePreview } from '../../src/main/files/memos';
import { memoFile, memoJsonPath } from '../../src/main/files/paths';

describe('MemoStore', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let store: MemoStore;
  let memosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memo-store-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    memosDir = join(dir, 'memos');
    store = new MemoStore(handle.db, memosDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a memo and reads it back', () => {
    const memo = store.create('买牛奶\n\n顺便取快递', 'drop');
    expect(memo.content).toBe('买牛奶\n\n顺便取快递');
    expect(memo.source).toBe('drop');
    expect(memo.preview).toBe('买牛奶');
    expect(memo.todoId).toBeNull();
    expect(memo.resolvedAt).toBeNull();
    expect(store.get(memo.id)?.id).toBe(memo.id);
  });

  it('projects content + metadata to disk', () => {
    const memo = store.create('设计稿第三版', 'manual');
    const mdir = join(memosDir, `${memo.id.slice(0, 6)}-设计稿第三版`);
    expect(readFileSync(memoFile(mdir), 'utf8')).toBe('设计稿第三版');
    const meta = JSON.parse(readFileSync(memoJsonPath(mdir), 'utf8'));
    expect(meta.id).toBe(memo.id);
    expect(meta.source).toBe('manual');
  });

  it('lists newest first and hides resolved memos by default', () => {
    const a = store.create('第一条', 'drop');
    const b = store.create('第二条', 'drop');
    const c = store.create('第三条', 'drop');
    expect(store.list().map((m) => m.id)).toEqual([c.id, b.id, a.id]);

    store.update(c.id, { resolvedAt: Date.now() });
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]);
    expect(store.list(true).map((m) => m.id)).toEqual([c.id, b.id, a.id]);
  });

  it('re-derives preview when content is edited', () => {
    const memo = store.create('旧标题', 'drop');
    const updated = store.update(memo.id, { content: '新标题\n第二行' });
    expect(updated?.preview).toBe('新标题');
    const mdir = join(memosDir, `${memo.id.slice(0, 6)}-新标题`);
    expect(readFileSync(memoFile(mdir), 'utf8')).toBe('新标题\n第二行');
  });

  it('updates todoId without rewriting the body projection', () => {
    const memo = store.create('正文不变', 'drop');
    const before = readFileSync(memoFile(join(memosDir, `${memo.id.slice(0, 6)}-正文不变`)), 'utf8');
    const todo = repo.create({ title: '登录页改版' });
    const updated = store.update(memo.id, { todoId: todo.id });
    expect(updated?.todoId).toBe(todo.id);
    const after = readFileSync(memoFile(join(memosDir, `${memo.id.slice(0, 6)}-正文不变`)), 'utf8');
    expect(after).toBe(before);
  });

  it('rejects attaching a memo to a todo that does not exist', () => {
    // The FK is the guard against inventing task ids (AGENTS.md
    // non-negotiable #10). Assert it, don't work around it.
    const memo = store.create('碎片', 'drop');
    expect(() => store.update(memo.id, { todoId: '01NOSUCHTASK' })).toThrow(/FOREIGN KEY/);
  });

  it('keeps the memo when its task is deleted', () => {
    // memos.todo_id is ON DELETE SET NULL: a fragment is the user's own
    // content and must not vanish because the task it referenced did.
    const memo = store.create('随任务消失吗', 'drop');
    const todo = repo.create({ title: '临时任务' });
    store.update(memo.id, { todoId: todo.id });
    handle.db.prepare('DELETE FROM todos WHERE id = ?').run(todo.id);
    const after = store.get(memo.id);
    expect(after).not.toBeNull();
    expect(after?.todoId).toBeNull();
  });

  it('removes the row and the whole directory', () => {
    const memo = store.create('待删除', 'drop');
    const mdir = join(memosDir, `${memo.id.slice(0, 6)}-待删除`);
    expect(existsSync(mdir)).toBe(true);
    store.remove(memo.id);
    expect(store.get(memo.id)).toBeNull();
    expect(existsSync(mdir)).toBe(false);
  });

  it('attaches a file from disk and reads it back as a data URL', () => {
    const src = join(dir, 'shot.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const memo = store.create('带图', 'drop');
    const att = store.attach(memo.id, src, 'image/png');
    expect(att.filePath).toContain(att.id);
    expect(store.get(memo.id)?.attachmentIds).toEqual([att.id]);

    const read = store.readAttachment(att.id);
    expect(read.mime).toBe('image/png');
    expect(read.filename).toBe('shot.png');
    expect(Buffer.from(read.dataUrl.split(',')[1]!, 'base64').length).toBe(4);
  });

  it('attaches a blob from a data URL', () => {
    const memo = store.create('粘贴的图', 'clipboard');
    const b64 = Buffer.from('hello').toString('base64');
    const att = store.attachBlob(memo.id, `data:text/plain;base64,${b64}`, 'note.txt', 'text/plain');
    expect(store.readAttachment(att.id).dataUrl).toBe(`data:text/plain;base64,${b64}`);
  });

  it('rejects attaching to an unknown memo', () => {
    expect(() => store.attachBlob('nope', 'data:text/plain,aGk=', 'a.txt', 'text/plain')).toThrow(
      /memo_not_found/,
    );
  });

  it('removes an attachment row', () => {
    const memo = store.create('x', 'drop');
    const att = store.attachBlob(memo.id, 'data:text/plain,aGk=', 'a.txt', 'text/plain');
    store.removeAttachment(att.id);
    expect(store.get(memo.id)?.attachmentIds).toEqual([]);
  });
});

describe('derivePreview', () => {
  it('takes the first non-empty line, collapsed and capped', () => {
    expect(derivePreview('\n\n  你好   世界 \n第二行')).toBe('你好 世界');
    expect(derivePreview('x'.repeat(80))).toHaveLength(61); // 60 + ellipsis
    expect(derivePreview('   ')).toBe('');
    expect(derivePreview('')).toBe('');
  });
});
