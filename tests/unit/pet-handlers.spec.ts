// pet.submit / pet.hide / pet.show IPC handlers.
//
// 关键不变量（每个测试断言其中一两条）：
//   1. 拖入纯文本 → prompt 直接用文本，images 为空
//   2. 拖入 path 类文件 → copyPathToInbox 落盘 + 注册 draft 索引
//   3. 拖入 blob 类文件 → writeBlobToInbox 解码 base64 → 落盘
//   4. settings.pet.enabled = false → 直接返回 ignored=true（静默丢弃）
//   5. 没有主窗口 → 返回 ignored=true
//   6. 单文件 > 50MB → failResult('file_too_large')
//   7. 同时拖文本 + 文件 → prompt = `${text}\n\n（来自悬浮宠物，见附件）`
//   8. 拖 0 个文件 + 0 文字 → failResult('empty')
//   9. 拖 > 10 个文件 → failResult('too_many_files')
//  10. invocationId 透传；broadcast 'app:external-ai-submit' 推到所有窗口

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub the electron module before importing the handler. We don't
// need a real BrowserWindow; just capture webContents.send calls so
// the test can assert what got broadcast.
const sentPayloads: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => {
  class FakeWebContents {
    sent: Array<{ channel: string; payload: unknown }> = [];
    send = (channel: string, payload: unknown): void => {
      this.sent.push({ channel, payload });
      sentPayloads.push({ channel, payload });
    };
  }
  const fakeWindows: Array<{ webContents: FakeWebContents; destroyed: boolean; size: number }> = [];
  return {
    BrowserWindow: {
      getAllWindows: () =>
        fakeWindows.map((w) => ({
          isDestroyed: () => w.destroyed,
          webContents: w.webContents,
          getSize: () => [w.size, 600],
        })),
      getFocusedWindow: () => null,
    },
    __mock: { fakeWindows, FakeWebContents },
  };
});

// Stub the logger so the test never touches userData / todo-list.log.
// SettingsStore.patch() dynamically imports logger to forward the new
// logLevel — the mock has to expose setThreshold too so that promise
// resolves without throwing unhandled rejections.
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
import {
  _resetForTests,
  initComposerInbox,
  listPathsForConv,
} from '../../src/main/ai/composer-inbox';
import type { PetController } from '../../src/main/pet/pet';
import type { PetFileRef } from '../../src/shared/ipc-schema';

function makeFakePet(): PetController {
  // We don't exercise the controller's window lifecycle here — the
  // handler only touches `deps.pet.hide()` / `deps.pet.show()` /
  // `deps.pet.dragBy()`.
  return {
    hide: vi.fn(),
    show: vi.fn(),
    dragBy: vi.fn(),
  } as unknown as PetController;
}

async function invoke(
  deps: Parameters<typeof handlePetSubmit>[0],
  req: { invocationId: string; text?: string; files: PetFileRef[] },
): Promise<{ ok: boolean; code?: string; message?: string; data?: unknown }> {
  return (await handlePetSubmit(deps, req)) as { ok: boolean; code?: string; message?: string; data?: unknown };
}

describe('pet IPC handlers', () => {
  let rootDir: string;
  let settings: SettingsStore;
  let pet: PetController;
  let deps: { rootDir: string; settings: SettingsStore; pet: PetController };
  let electronMock: {
    fakeWindows: Array<{ webContents: { sent: unknown[] }; destroyed: boolean; size: number }>;
    FakeWebContents: new () => { sent: unknown[]; send: (ch: string, p: unknown) => void };
  };

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'todo-list-pet-handlers-'));
    settings = new SettingsStore(rootDir);
    // Pet defaults to disabled in production; enable here so the
    // happy-path tests actually exercise the submit handler.
    settings.patch({ pet: { enabled: true } });
    pet = makeFakePet();
    deps = { rootDir, settings, pet };
    sentPayloads.length = 0;
    _resetForTests();
    initComposerInbox(rootDir);
    electronMock = (await import('electron' as unknown as { __mock: typeof electronMock }))
      .__mock as never;
    electronMock.fakeWindows.length = 0;
    // Default: one main window ≥ 800 wide + the pet window itself.
    electronMock.fakeWindows.push({
      webContents: { sent: [], send: (ch, p) => sentPayloads.push({ channel: ch, payload: p }) },
      destroyed: false,
      size: 1280,
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    _resetForTests();
  });

  it('drops text-only submission into broadcast with empty images', async () => {
    const res = await invoke(deps, {
      invocationId: 'inv-1',
      text: '记得交房租',
      files: [],
    });
    expect(res.ok).toBe(true);
    const broadcast = sentPayloads.find((p) => p.channel === 'app:external-ai-submit');
    expect(broadcast).toBeTruthy();
    const payload = broadcast!.payload as {
      intent: string;
      prompt: string;
      images: unknown;
      invocationId: string;
    };
    expect(payload.intent).toBe('create-task');
    expect(payload.prompt).toBe('记得交房租');
    expect(payload.images).toBeUndefined();
    expect(payload.invocationId).toBe('inv-1');
  });

  it('copies a path-style file to the draft inbox slot', async () => {
    const src = join(rootDir, 'note.txt');
    writeFileSync(src, '项目 demo 周三上线');
    const res = await invoke(deps, {
      invocationId: 'inv-2',
      files: [{ name: 'note.txt', path: src }],
    });
    expect(res.ok).toBe(true);
    // Files landed in dsh_workspace/inbox under `draft` key.
    const draftPaths = listPathsForConv(rootDir, 'draft');
    expect(draftPaths).toHaveLength(1);
    expect(draftPaths[0]).toMatch(/note\.txt$/);
    expect(readFileSync(draftPaths[0]!, 'utf8')).toBe('项目 demo 周三上线');
    // Broadcast carries the inboxed image metadata.
    const broadcast = sentPayloads.find((p) => p.channel === 'app:external-ai-submit')!.payload as {
      images: Array<{ name: string; path: string; size: number; mime: string }>;
      prompt: string;
    };
    expect(broadcast.images).toHaveLength(1);
    expect(broadcast.images[0]!.name).toBe('note.txt');
    expect(broadcast.images[0]!.path).toBe(draftPaths[0]);
    expect(broadcast.images[0]!.size).toBe(Buffer.byteLength('项目 demo 周三上线', 'utf8'));
    expect(broadcast.images[0]!.mime).toBe('text/plain');
    expect(broadcast.prompt).toContain('请读取附件');
  });

  it('decodes a blob fallback (data URL) into the inbox', async () => {
    // 1x1 transparent PNG bytes (base64). Tiny so the test stays fast.
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const dataUrl = `data:image/png;base64,${pngB64}`;
    const res = await invoke(deps, {
      invocationId: 'inv-3',
      files: [{ name: 'pixel.png', mime: 'image/png', dataUrl }],
    });
    expect(res.ok).toBe(true);
    const draftPaths = listPathsForConv(rootDir, 'draft');
    expect(draftPaths).toHaveLength(1);
    expect(existsSync(draftPaths[0]!)).toBe(true);
  });

  it('returns ignored=true when settings.pet.enabled is false', async () => {
    settings.patch({ pet: { enabled: false } });
    const res = await invoke(deps, {
      invocationId: 'inv-4',
      text: 'should be ignored',
      files: [],
    });
    expect(res.ok).toBe(true);
    expect(res.data?.ignored).toBe(true);
    expect(sentPayloads.find((p) => p.channel === 'app:external-ai-submit')).toBeUndefined();
  });

  it('returns ignored=true when no main window is open', async () => {
    electronMock.fakeWindows.length = 0; // close the only window
    const res = await invoke(deps, {
      invocationId: 'inv-5',
      text: 'alone',
      files: [],
    });
    expect(res.ok).toBe(true);
    expect(res.data?.ignored).toBe(true);
  });

  it('rejects >50MB path-style files with file_too_large', async () => {
    const src = join(rootDir, 'big.bin');
    // Write just enough bytes to look big but don't actually fill the disk
    // — we only need statSync().size to exceed MAX_FILE_BYTES.
    writeFileSync(src, Buffer.alloc(0));
    // Spoof the size by writing then patching — fs.statSync reports the
    // real size, so we directly patch the handler's behavior via a
    // mounted file with the right size. Quick path: write 51 MB.
    const big = Buffer.alloc(51 * 1024 * 1024);
    writeFileSync(src, big);
    const res = await invoke(deps, {
      invocationId: 'inv-6',
      files: [{ name: 'big.bin', path: src }],
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('file_too_large');
  });

  it('rejects >10 files with too_many_files', async () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.txt`,
      path: join(rootDir, `f${i}.txt`),
    }));
    for (const r of refs) writeFileSync(r.path, 'x');
    const res = await invoke(deps, {
      invocationId: 'inv-7',
      files: refs,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('too_many_files');
  });

  it('rejects empty (no text + no files) with empty', async () => {
    const res = await invoke(deps, {
      invocationId: 'inv-8',
      files: [],
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('empty');
  });

  it('combines text + files with the 「（来自悬浮宠物，见附件）」 wrapper', async () => {
    const src = join(rootDir, 'plan.md');
    writeFileSync(src, '- 上线计划');
    const res = await invoke(deps, {
      invocationId: 'inv-9',
      text: '周三上线',
      files: [{ name: 'plan.md', path: src }],
    });
    expect(res.ok).toBe(true);
    const broadcast = sentPayloads.find((p) => p.channel === 'app:external-ai-submit')!.payload as {
      prompt: string;
    };
    expect(broadcast.prompt).toBe('周三上线\n\n（来自悬浮宠物，见附件）');
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