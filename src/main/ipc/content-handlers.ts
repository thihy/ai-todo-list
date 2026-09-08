// IPC handlers for content.* + drawing.* channels.

import { okResult, failResult, register } from './router';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import { logger } from '../logger';

export function registerContentHandlers(
  md: MarkdownStore,
  drawings: DrawingStore,
): void {
  register('content.readBody', (_e, req) => {
    try {
      return Promise.resolve(okResult(md.readBody(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('read_failed', (err as Error).message));
    }
  });

  register('content.writeBody', (_e, req) => {
    try {
      const res = md.writeBody(req.id, req.markdown, req.expectVersion);
      return Promise.resolve(okResult(res));
    } catch (err) {
      const message = (err as Error).message;
      const isConflict = message.startsWith('version_conflict');
      return Promise.resolve(
        failResult(isConflict ? 'version_conflict' : 'write_failed', message),
      );
    }
  });

  register('content.history', (_e, req) => {
    try {
      return Promise.resolve(okResult(md.history(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('history_failed', (err as Error).message));
    }
  });

  register('content.restoreVersion', (_e, req) => {
    try {
      md.restoreVersion(req.id, req.versionId);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('restore_failed', (err as Error).message));
    }
  });

  register('drawing.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(drawings.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('drawing.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(drawings.read(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('read_failed', (err as Error).message));
    }
  });

  register('drawing.save', (_e, req) => {
    try {
      return Promise.resolve(
        okResult(drawings.save(req.todoId, req.scene, req.id, req.title)),
      );
    } catch (err) {
      return Promise.resolve(failResult('save_failed', (err as Error).message));
    }
  });

  register('drawing.delete', (_e, req) => {
    try {
      drawings.delete(req.id);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('delete_failed', (err as Error).message));
    }
  });

  register('drawing.setThumb', (_e, req) => {
    try {
      drawings.setThumb(req.id, req.dataUrl);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('thumb_failed', (err as Error).message));
    }
  });

  logger.info('content.* + drawing.* handlers registered');
}