// IPC handlers for the desktop floating pet.
//
// pet.submit: validate dropped files → drop them into the composer
// inbox (convId=null so they land under the `draft` index key —
// AIPane.runSubmit calls `relinkDraft` on its end to move them under
// the real conversationId once it allocates one) → build an
// ExternalAiSubmitDetail → broadcast `app:external-ai-submit` to all
// windows. The main window's App.tsx subscriber routes the payload
// into its AIPane via `pendingAiCreate` + opens the panel.
//
// The pet window itself doesn't submit to ai.ask directly because that
// would duplicate the AIPane submission pipeline (relinkDraft,
// conversationId allocation, history threading, etc.). Reusing
// AIPane keeps the single source of truth for "how a turn starts".
//
// pet.hide / pet.show are convenience toggles exposed via the pet's
// context menu and the tray menu item.

import { BrowserWindow } from 'electron';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { okResult, failResult, register } from './router';
import type { IpcResult, PetFileRef } from '../../shared/ipc-schema';
import type { PetDragArgs } from '../../shared/todo-list-api';
import * as composerInbox from '../ai/composer-inbox';
import type { PetController } from '../pet/pet';
import type { SettingsStore } from '../settings/store';
import { logger } from '../logger';

export interface PetHandlerDeps {
  rootDir: string;
  settings: SettingsStore;
  pet: PetController;
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

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('dataUrl 格式不正确');
  const mime = m[1] || 'application/octet-stream';
  const b64 = m[2] ?? '';
  return { mime, bytes: Buffer.from(b64, 'base64') };
}

export interface PetSubmitRequest {
  invocationId: string;
  text?: string;
  files: PetFileRef[];
}

export function registerPetHandlers(deps: PetHandlerDeps): void {
  register('pet.submit', async (_e, req) => handlePetSubmit(deps, req));
  register('pet.hide', async () => handlePetHide(deps));
  register('pet.show', async () => handlePetShow(deps));
  register('pet.drag', async (_e, req) => handlePetDrag(deps, req));
}

/** pet.submit handler. Validates dropped files, copies them into the
 *  composer inbox (convId=null → 'draft' key), then broadcasts
 *  `app:external-ai-submit` to every renderer. Exported so unit
 *  tests can call it directly without going through the IPC router
 *  (which requires a live electron ipcMain). */
export async function handlePetSubmit(
  deps: PetHandlerDeps,
  req: PetSubmitRequest,
): Promise<IpcResult<{ ignored?: boolean }>> {
  try {
    // Disabled toggle → drop is silently ignored. This is the
    // path taken if a stale pet window is somehow still alive
    // when settings.pet.enabled flips to false.
    if (!deps.settings.get().pet.enabled) {
      return okResult({ ignored: true });
    }
    // No main window → nothing to dispatch to. Same code path as
    // disabled — ignored rather than failed so the pet doesn't
    // show an error toast every time the main window is briefly
    // mid-restart.
    if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.getSize()[0] >= 800)) {
      return okResult({ ignored: true });
    }

    const text = (req.text ?? '').slice(0, MAX_TEXT_BYTES);
    if (req.files.length > MAX_FILES) {
      return failResult('too_many_files', `一次最多拖入 ${MAX_FILES} 个文件`);
    }
    if (req.files.length === 0 && !text) {
      return failResult('empty', '请至少拖入一个文件或输入文字');
    }

    const images: Array<{ name: string; mime: string; path: string; size: number }> = [];
    for (const f of req.files) {
      if ('path' in f) {
        // Disk-OS copy — copied from `path`.
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
        const ext = extname(f.path || f.name);
        const mime = mimeFromExt(ext);
        const result = await composerInbox.copyPathToInbox(
          deps.rootDir,
          f.path,
          basename(f.name),
          mime,
          null,
        );
        images.push({ name: result.name, mime: result.mime, path: result.path, size: result.size });
      } else {
        // Web-OS blob fallback — decoded from data URL.
        let decoded: { mime: string; bytes: Buffer };
        try {
          decoded = decodeDataUrl(f.dataUrl);
        } catch (err) {
          return failResult(
            'bad_data_url',
            `文件 ${f.name} 数据格式不正确: ${(err as Error).message}`,
          );
        }
        if (decoded.bytes.byteLength > MAX_FILE_BYTES) {
          return failResult('file_too_large', `文件 ${f.name} 超过 50MB 上限`);
        }
        const mime = f.mime || decoded.mime;
        const result = await composerInbox.writeBlobToInbox(
          deps.rootDir,
          basename(f.name),
          mime,
          decoded.bytes,
          null,
        );
        images.push({ name: result.name, mime: result.mime, path: result.path, size: result.size });
      }
    }

    // Build the user-visible prompt. Three shapes:
    //   - files only: "（从桌面悬浮宠物拖入的内容）请读取附件识别待办并创建任务。"
    //   - text only:  verbatim (no extra wrapper)
    //   - both:       text + 「（见附件）」
    let prompt: string;
    if (images.length > 0 && text) {
      prompt = `${text}\n\n（来自悬浮宠物，见附件）`;
    } else if (images.length > 0) {
      prompt = '（从桌面悬浮宠物拖入的内容）请读取附件识别其中的待办事项并创建任务。';
    } else {
      prompt = text;
    }

    const detail = {
      intent: 'create-task' as const,
      prompt,
      images: images.length > 0 ? images : undefined,
      invocationId: req.invocationId,
      notifySource: true,
    };

    // Broadcast to every renderer. The pet itself listens too so it
    // can render progress in its own UI; the main window picks it
    // up via App.tsx and routes into AIPane.
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send('app:external-ai-submit', detail);
    }
    logger.info(`pet.submit: dispatched (files=${images.length}, text=${text.length} chars)`);
    return okResult({ ignored: false });
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