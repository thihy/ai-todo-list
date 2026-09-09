// IPC handlers for document.* channels (multi-document workspace, schema v11).

import { BrowserWindow } from 'electron';
import { okResult, failResult, register } from './router';
import type { DocumentStore } from '../files/documents';
import { logger } from '../logger';

/** Broadcast a content-scope data-changed so any open editor refetches its
 *  documents after a mutation (mirrors the todo/progress broadcast pattern). */
function broadcastDataChanged(scope: 'content'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}

export function registerDocumentHandlers(docs: DocumentStore): void {
  register('document.list', (_e, req) => {
    try {
      // Ensure the default progress doc exists — covers todos created after
      // the v11 migration (which only back-fills pre-existing todos).
      docs.ensureDefaultDocs(req.todoId);
      return Promise.resolve(okResult(docs.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('document_list_failed', (err as Error).message));
    }
  });

  register('document.create', (_e, req) => {
    try {
      const doc = docs.create(req.todoId, req.kind, req.title ?? null, {
        refId: req.refId,
        url: req.url,
      });
      broadcastDataChanged('content');
      return Promise.resolve(okResult(doc));
    } catch (err) {
      return Promise.resolve(failResult('document_create_failed', (err as Error).message));
    }
  });

  register('document.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.read(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('document_read_failed', (err as Error).message));
    }
  });

  register('document.write', (_e, req) => {
    try {
      const res = docs.write(req.id, req.content, req.expectVersion);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(res));
    } catch (err) {
      const message = (err as Error).message;
      const isConflict = message.startsWith('version_conflict');
      return Promise.resolve(
        failResult(isConflict ? 'version_conflict' : 'document_write_failed', message),
      );
    }
  });

  register('document.rename', (_e, req) => {
    try {
      docs.rename(req.id, req.title);
      return Promise.resolve(okResult(docs.get(req.id)!));
    } catch (err) {
      return Promise.resolve(failResult('document_rename_failed', (err as Error).message));
    }
  });

  register('document.remove', (_e, req) => {
    try {
      docs.remove(req.id);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('document_remove_failed', (err as Error).message));
    }
  });

  register('document.history', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.history(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('document_history_failed', (err as Error).message));
    }
  });

  register('document.restoreVersion', (_e, req) => {
    try {
      docs.restoreVersion(req.id, req.versionId);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('document_restore_failed', (err as Error).message));
    }
  });

  logger.info('document.* handlers registered');
}
