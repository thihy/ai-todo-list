// IPC handlers for the desktop floating pet.
//
// pet.submit: validate dropped files → drop them straight into the memos
// table (read_at = NULL → "未读"). This replaces the old AI-submit relay:
// the pet is a "随手丢" surface, not a "启动 AI" trigger. The
// `app:external-ai-submit` pipeline (composer inbox + AIPane.runSubmit) is
// still wired and used by the capture window — only the pet entry point
// has changed.
//
// pet.hide / pet.show are convenience toggles exposed via the pet's
// context menu and the tray menu item.

import { BrowserWindow } from 'electron';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { okResult, failResult, register } from './router';
import type { IpcResult, PetFileRef } from '../../shared/ipc-schema';
import type { PetDragArgs } from '../../shared/todo-list-api';
import type { MemoStore } from '../files/memos';
import type { PetController } from '../pet/pet';
import type { SettingsStore } from '../settings/store';
import { logger } from '../logger';

export interface PetHandlerDeps {
  settings: SettingsStore;
  pet: PetController;
  /** 直落到备忘录，所以必须注入 MemoStore。同一份验证逻辑也走这里。 */
  memos: MemoStore;
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_TEXT_BYTES = 50 * 1024; // 50 KB of plaintext

/** Best-effort mime from extension. Mirrors the inline helper in
 *  src/main/index.ts — kept local so this module doesn't depend on
 *  the main entrypoint's internals (and unit tests can import it in
 *  isolation). */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.h': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.hpp': 'text/x-c++',
    '.sh': 'text/x-shellscript',
    '.ps1': 'text/x-powershell',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

export interface PetSubmitRequest {
  text?: string;
  files: PetFileRef[];
}

export function registerPetHandlers(deps: PetHandlerDeps): void {
  register('pet.submit', async (_e, req) => handlePetSubmit(deps, req));
  register('pet.hide', async () => handlePetHide(deps));
  register('pet.show', async () => handlePetShow(deps));
  register('pet.drag', async (_e, req) => handlePetDrag(deps, req));
}

/** pet.submit —— 直接落备忘录（read_at = NULL → "未读"）。
 *
 *  校验：text 截 50KB，文件 ≤ 10 个、单文件 ≤ 50MB（与 memo 入口的上限
 *  一致）。校验通过后调 `MemoStore.create` + `attach`/`attachBlob`，附件
 *  落盘到 `{dataDir}/memos/{id}/attachments/` 而不是 `composer-inbox/`。
 *  返回 `{ ignored: true }` 当 pet 被禁用（settings 关闭或主窗口缺失）。
 *  这条路径**不**唤起主窗口、不发 `app:external-ai-submit` —— 桌面宠物是
 *  "随手丢"，主窗口要的是「静默接收」。 */
export async function handlePetSubmit(
  deps: PetHandlerDeps,
  req: PetSubmitRequest,
): Promise<IpcResult<{ ignored?: boolean; memoId?: string }>> {
  try {
    // Disabled toggle → drop is silently ignored. Stale pet windows can
    // outlive settings.pet.enabled flipping to false on rare races.
    if (!deps.settings.get().pet.enabled) {
      return okResult({ ignored: true });
    }

    const text = (req.text ?? '').slice(0, MAX_TEXT_BYTES);
    if (req.files.length > MAX_FILES) {
      return failResult('too_many_files', `一次最多拖入 ${MAX_FILES} 个文件`);
    }
    if (req.files.length === 0 && !text) {
      return failResult('empty', '请至少拖入一个文件或输入文字');
    }

    // 预校验单文件大小/可读性，避免 attach 半拷贝才发现问题。
    for (const f of req.files) {
      if ('path' in f) {
        let size: number;
        try {
          size = statSync(f.path).size;
        } catch (err) {
          return failResult(
            'file_unreadable',
            `无法读取文件 ${f.name}: ${(err as Error).message}`,
          );
        }
        if (size > MAX_FILE_BYTES) {
          return failResult('file_too_large', `文件 ${f.name} 超过 50MB 上限`);
        }
      } else if (f.size != null && f.size > MAX_FILE_BYTES) {
        return failResult('file_too_large', `文件 ${f.name} 超过 50MB 上限`);
      }
    }

    // 内容：纯文本原样；有附件无文本 → 一个明确的占位让用户看到「这是我拖进来的」。
    const content = text || (req.files.length > 0 ? '（拖入的附件）' : '');
    const memo = deps.memos.create(content, 'drop');
    for (const f of req.files) {
      const name = basename(f.name);
      if ('path' in f) {
        const mime = mimeFromExt(extname(f.path || f.name));
        deps.memos.attach(memo.id, f.path, mime);
      } else {
        const mime = f.mime || mimeFromExt(extname(f.name));
        deps.memos.attachBlob(memo.id, f.dataUrl, name, mime);
      }
    }
    // 附件挂上后重投影 + 重读，让 memo.json 快照带上 attachmentIds。
    deps.memos.writeProjection(deps.memos.get(memo.id)!);
    const finalMemo = deps.memos.get(memo.id)!;

    // 广播：所有窗口（主窗口的 MemoSection、主窗口的 memo 统计区）刷新。
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope: 'memos' });
    }
    logger.info(
      `pet.submit: stored memo (id=${finalMemo.id}, files=${req.files.length}, text=${text.length} chars)`,
    );
    return okResult({ ignored: false, memoId: finalMemo.id });
  } catch (err) {
    return failResult('pet_submit_failed', (err as Error).message);
  }
}

export async function handlePetHide(deps: PetHandlerDeps): Promise<IpcResult<undefined>> {
  try {
    deps.pet.hide();
    return okResult(undefined);
  } catch (err) {
    return failResult('pet_hide_failed', (err as Error).message);
  }
}

export async function handlePetShow(deps: PetHandlerDeps): Promise<IpcResult<undefined>> {
  try {
    deps.pet.show();
    return okResult(undefined);
  } catch (err) {
    return failResult('pet_show_failed', (err as Error).message);
  }
}

/** pet.drag — drive the pet window's manual drag.
 *
 *  This exists because `-webkit-app-region: drag` cannot be used for the
 *  pet: Chromium routes an app-region drag to the OS as a native window
 *  move and never delivers HTML5 drag events to the page, so the drop
 *  target is dead and the cursor shows the "forbidden" no-drop badge.
 *  Instead the renderer implements dragging itself (pointerdown →
 *  pointermove → pet.drag) and the whole surface stays an ordinary
 *  drop target.
 *
 *  The renderer sends incremental deltas, and main accumulates them onto a
 *  position captured at drag start. Accumulating here rather than in the
 *  renderer keeps the window from drifting: setPosition() rounds to whole
 *  pixels, so an absolute-position scheme would compound that error on
 *  every pointermove. */
export async function handlePetDrag(
  deps: PetHandlerDeps,
  req: PetDragArgs,
): Promise<IpcResult<undefined>> {
  try {
    deps.pet.dragBy(req);
    return okResult(undefined);
  } catch (err) {
    return failResult('pet_drag_failed', (err as Error).message);
  }
}