// IPC handlers for tag.* channels — the user-facing tag management
// surface (catalog + rename + merge + cleanup). All mutations go
// through TagRepo; this layer just translates IPC envelopes to
// typed calls + broadcasts the `app:tags-changed` event so other
// open windows (and the renderer's reactive hooks) refresh.
//
// Event semantics:
//   - Every successful mutation emits `app:tags-changed` once. The
//     payload is the affected task id list (so the renderer's data
//     bus can refresh the matching todos without a full re-fetch).
//   - The rename / merge / cleanup operations are atomic on the
//     TagRepo side (single SQLite transaction). On failure the
//     handler returns an IpcResult failure WITHOUT broadcasting —
//     nothing changed, so no refresh is needed.

import { BrowserWindow } from 'electron';
import { okResult, failResult, register } from './router';
import { logger } from '../logger';
import type {
  CleanupActions,
  CleanupPreview,
  TagRepo,
} from '../db/tag-repo';

function broadcastTagsChanged(payload: { affectedTodoIds?: string[] }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:tags-changed', payload);
  }
}

export function registerTagHandlers(tagRepo: TagRepo): void {
  register('tag.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(tagRepo.list({ activeOnly: req.activeOnly ?? false })));
    } catch (err) {
      return Promise.resolve(failResult('tag_list_failed', (err as Error).message));
    }
  });

  register('tag.activeCatalog', () => {
    try {
      return Promise.resolve(okResult(tagRepo.activeCatalog()));
    } catch (err) {
      return Promise.resolve(failResult('tag_catalog_failed', (err as Error).message));
    }
  });

  register('tag.rename', (_e, req) => {
    try {
      tagRepo.rename(req.oldName, req.newName);
      logger.info(`tag.rename: ${req.oldName} → ${req.newName}`);
      broadcastTagsChanged({});
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('tag_rename_failed', (err as Error).message));
    }
  });

  register('tag.merge', (_e, req) => {
    try {
      const result = tagRepo.merge(req.sources, req.target, { newColor: req.newColor });
      logger.info(`tag.merge: ${req.sources.join(', ')} → ${req.target} (${result.affectedTodoIds.length} task(s))`);
      broadcastTagsChanged({ affectedTodoIds: result.affectedTodoIds });
      return Promise.resolve(okResult(result));
    } catch (err) {
      return Promise.resolve(failResult('tag_merge_failed', (err as Error).message));
    }
  });

  register('tag.previewCleanup', () => {
    try {
      return Promise.resolve(okResult(tagRepo.previewCleanup() satisfies CleanupPreview));
    } catch (err) {
      return Promise.resolve(failResult('tag_preview_failed', (err as Error).message));
    }
  });

  register('tag.applyCleanup', (_e, req) => {
    try {
      const result = tagRepo.applyCleanup(req.actions satisfies CleanupActions);
      logger.info(
        `tag.applyCleanup: ${result.affectedTodoIds.length} affected, ` +
        `${result.skipped.length} skipped`,
      );
      broadcastTagsChanged({ affectedTodoIds: result.affectedTodoIds });
      return Promise.resolve(okResult(result));
    } catch (err) {
      // TagRepo throws a typed CleanupError on rollback; surface the
      // message verbatim. The user sees a precise reason — never the
      // raw exception object.
      return Promise.resolve(failResult('tag_cleanup_failed', (err as Error).message));
    }
  });

  register('tag.reactivate', (_e, req) => {
    try {
      tagRepo.reactivate(req.name);
      broadcastTagsChanged({});
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('tag_reactivate_failed', (err as Error).message));
    }
  });

  logger.info('tag.* handlers registered');
}