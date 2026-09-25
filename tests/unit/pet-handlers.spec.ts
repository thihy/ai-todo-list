// pet.submit / pet.hide / pet.show IPC handlers.
//
// pet.submit 已经从「AI 中转」改成「直落备忘录」：拖入 → 写到 memos 表
// (read_at = NULL → "未读") → 广播 app:data-changed { scope: 'memos' }。
// 这条路径不唤起主窗口、不发 app:external-ai-submit —— 桌面宠物是
// "随手丢"，不是 "启动 AI"。
//
// 关键不变量（每个测试断言其中一两条）：
//   1. 拖入纯文本 → memo.content = text, readAt === null（"未读"）
//   2. 拖入 path 类文件 → store.attach 落盘 + attachmentIds 列出
//   3. 拖入 blob 类文件 → store.attachBlob 解码 base64 → 落盘
//   4. settings.pet.enabled = false → 直接返回 ignored=true（静默丢弃）
//   5. 没有主窗口 → 仍然处理（宠物独立于主窗口状态）
//   6. 单文件 > 50MB → failResult('file_too_large')
//   7. 同时拖文本 + 文件 → memo.content = text，附件独立挂
//   8. 拖 0 个文件 + 0 文字 → failResult('empty')
//   9. 拖 > 10 个文件 → failResult('too_many_files')
//  10. 不再发 app:external-ai-submit —— 那是 capture 窗口 / AIPane 的事

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub the electron module before importing the handler. We don't
// need a real BrowserWindow; just capture webContents.send calls so
// the test can assert what got broadcast.
const sentPayloads: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => {
  class FakeWebContents {
    send = (channel: string, payload: unknown): void => {
      sentPayloads.push({ channel, payload });
    };
  }
  const fakeWindows: Array<{ webContents: FakeWebContents; destroyed: boolean }> = [];
  return {
    BrowserWindow: {
      getAllWindows: () =>
        fakeWindows.map((w) => ({
          isDestroyed: () => w.destroyed,
          webContents: w.webContents,
        })),
    },
    __mock: { fakeWindows, FakeWebContents },
  };
});

vi.mock('../../src/main/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setThreshold: vi.fn(),
  },
}));

import {
  handlePetSubmit,
  handlePetHide,
  handlePetShow,
  handlePetDrag,
} from '../../src/main/ipc/pet-handlers';
import { SettingsStore } from '../../src/main/settings/store';
import { MemoStore } from '../../src/main/files/memos';
import { openDb } from '../../src/main/db/schema';
import type { PetController } from '../../src/main/pet/pet';
import type { PetFileRef } from '../../src/shared/ipc-schema';
import type { Memo } from '../../src/shared/todo-types';

function makeFakePet(): PetController {
  // The handler only touches deps.pet.hide() / .show() / .dragBy().
  return {
    hide: vi.fn(),
    show: vi.fn(),
    dragBy: vi.fn(),
  } as unknown as PetController;
}

async function invoke(
  deps: Parameters<typeof handlePetSubmit>[0],
  req: { text?: string; files: PetFileRef[] },
): Promise<{ ok: boolean; code?: string; message?: string; data?: unknown }> {
  return (await handlePetSubmit(deps, req)) as {
    ok: boolean;
    code?: string;
    message?: string;
    data?: unknown;
  };
}

describe('pet IPC handlers', () => {
  let rootDir: string;
  let settings: SettingsStore;
  let pet: PetController;
  let memos: MemoStore;
  let deps: {
    settings: SettingsStore;
    pet: PetController;
    memos: MemoStore;
  };
  let electronMock: {
    fakeWindows: Array<{ webContents: { sent: unknown[] }; destroyed: boolean }>;
  };
  let dbHandle: ReturnType<typeof openDb>;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'todo-list-pet-handlers-'));
    settings = new SettingsStore(rootDir);
    // Pet defaults to disabled in production; enable here so happy-path
    // tests actually exercise the submit handler.
    settings.patch({ pet: { enabled: true } });
    pet = makeFakePet();
    dbHandle = openDb(join(rootDir, 'db.sqlite'));
    memos = new MemoStore(dbHandle.db, join(rootDir, 'memos'));
    deps = { settings, pet, memos };
    sentPayloads.length = 0;
    electronMock = (await import('electron' as unknown as {
      __mock: typeof electronMock;
    })).__mock as never;
    electronMock.fakeWindows.length = 0;
    // Default: one main window — verify broadcasts actually have somewhere to go.
    electronMock.fakeWindows.push({
      webContents: { sent: [], send: (ch, p) => sentPayloads.push({ channel: ch, payload: p }) },
      destroyed: false,
    });
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('drops text-only input into a fresh memo (unread)', async () => {
    const res = await invoke(deps, { text: '记得交房租', files: [] });
    expect(res.ok).toBe(true);
    const memoId = (res.data as { memoId?: string }).memoId;
    expect(memoId).toBeTruthy();

    const list = memos.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(memoId);
    expect(list[0].content).toBe('记得交房租');
    expect(list[0].source).toBe('drop');
    // 这是这一改动的核心不变量：宠物丢进来的东西默认未读
    expect(list[0].readAt).toBeNull();

    // broadcast = memos scope only —— 不再发 app:external-ai-submit
    const channels = sentPayloads.map((p) => p.channel);
    expect(channels).toContain('app:data-changed');
    expect(channels).not.toContain('app:external-ai-submit');
    const scopes = sentPayloads
      .filter((p) => p.channel === 'app:data-changed')
      .map((p) => (p.payload as { scope: string }).scope);
    expect(scopes).toContain('memos');
  });

  it('copies a path-style file into the memo attachments', async () => {
    const src = join(rootDir, 'note.txt');
    writeFileSync(src, '项目 demo 周三上线');
    const res = await invoke(deps, {
      files: [{ name: 'note.txt', path: src }],
    });
    expect(res.ok).toBe(true);
    const memoId = (res.data as { memoId?: string }).memoId!;
    const memo = memos.get(memoId) as Memo;
    expect(memo.attachmentIds).toHaveLength(1);
    expect(memo.content).toBe('（拖入的附件）'); // 没有 text 时给个明确的占位
    // readAttachment 自身就在文件丢失时抛 memo_attachment_missing：
    // 如果这条断言没炸，磁盘文件就一定在。dataUrl 的 base64 头是 mime
    // 落对的旁证。
    const att = memos.readAttachment(memo.attachmentIds[0]!);
    expect(att.mime).toBe('text/plain');
    expect(att.dataUrl.startsWith('data:text/plain;base64,')).toBe(true);
    const decoded = Buffer.from(att.dataUrl.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).toBe('项目 demo 周三上线');
  });

  it('decodes a blob fallback (data URL) into the memo attachments', async () => {
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const dataUrl = `data:image/png;base64,${pngB64}`;
    const res = await invoke(deps, {
      files: [{ name: 'pixel.png', mime: 'image/png', dataUrl }],
    });
    expect(res.ok).toBe(true);
    const memoId = (res.data as { memoId?: string }).memoId!;
    const memo = memos.get(memoId) as Memo;
    expect(memo.attachmentIds).toHaveLength(1);
    const att = memos.readAttachment(memo.attachmentIds[0]!);
    expect(att.mime).toBe('image/png');
    // 不严格断言 filename —— attachBlob 总是按 mime 补扩展名，对
    // 已经带扩展名的输入会得到 "pixel.png.png"，这是已知既有行为，
    // 与本次改动无关。
    expect(att.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('returns ignored=true when settings.pet.enabled is false', async () => {
    settings.patch({ pet: { enabled: false } });
    const res = await invoke(deps, { text: 'should be ignored', files: [] });
    expect(res.ok).toBe(true);
    expect(res.data?.ignored).toBe(true);
    // No memo created, no broadcast.
    expect(memos.list()).toHaveLength(0);
    expect(sentPayloads.filter((p) => p.channel === 'app:data-changed')).toEqual([]);
  });

  it('does NOT require a main window (pet is independent of main-window state)', async () => {
    // 宠物不依赖主窗口 —— 即使主窗口被关掉，丢进来的内容也照常落 memo。
    electronMock.fakeWindows.length = 0;
    const res = await invoke(deps, { text: 'main 窗口关了', files: [] });
    expect(res.ok).toBe(true);
    expect(res.data?.ignored).toBeFalsy();
    expect(memos.list()).toHaveLength(1);
  });

  it('rejects >50MB path-style files with file_too_large', async () => {
    const src = join(rootDir, 'big.bin');
    const big = Buffer.alloc(51 * 1024 * 1024);
    writeFileSync(src, big);
    const res = await invoke(deps, { files: [{ name: 'big.bin', path: src }] });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('file_too_large');
    // 失败路径不能留半成品 memo
    expect(memos.list()).toHaveLength(0);
  });

  it('rejects >10 files with too_many_files', async () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.txt`,
      path: join(rootDir, `f${i}.txt`),
    }));
    for (const r of refs) writeFileSync(r.path, 'x');
    const res = await invoke(deps, { files: refs });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('too_many_files');
  });

  it('rejects empty (no text + no files) with empty', async () => {
    const res = await invoke(deps, { files: [] });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('empty');
  });

  it('combines text + files: text becomes the memo body, attachments stay independent', async () => {
    const src = join(rootDir, 'plan.md');
    writeFileSync(src, '- 上线计划');
    const res = await invoke(deps, {
      text: '周三上线',
      files: [{ name: 'plan.md', path: src }],
    });
    expect(res.ok).toBe(true);
    const memoId = (res.data as { memoId?: string }).memoId!;
    const memo = memos.get(memoId) as Memo;
    expect(memo.content).toBe('周三上线'); // 不再追加「（来自悬浮宠物，见附件）」
    expect(memo.attachmentIds).toHaveLength(1);
  });

  it('pet.hide calls deps.pet.hide()', async () => {
    await handlePetHide(deps);
    expect((pet as unknown as { hide: ReturnType<typeof vi.fn> }).hide).toHaveBeenCalled();
  });

  it('pet.show calls deps.pet.show()', async () => {
    await handlePetShow(deps);
    expect((pet as unknown as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalled();
  });

  // pet.drag is what replaced `-webkit-app-region: drag`. If this
  // regresses, the pet can't be repositioned and the drop target breaks
  // again, so assert the exact step object reaches the controller.
  it('pet.drag forwards each phase to deps.pet.dragBy()', async () => {
    const dragBy = (pet as unknown as { dragBy: ReturnType<typeof vi.fn> }).dragBy;

    expect((await handlePetDrag(deps, { phase: 'start' })).ok).toBe(true);
    expect(dragBy).toHaveBeenLastCalledWith({ phase: 'start' });

    expect((await handlePetDrag(deps, { phase: 'move', dx: 12, dy: -7 })).ok).toBe(true);
    expect(dragBy).toHaveBeenLastCalledWith({ phase: 'move', dx: 12, dy: -7 });

    expect((await handlePetDrag(deps, { phase: 'end' })).ok).toBe(true);
    expect(dragBy).toHaveBeenLastCalledWith({ phase: 'end' });

    expect(dragBy).toHaveBeenCalledTimes(3);
  });
});