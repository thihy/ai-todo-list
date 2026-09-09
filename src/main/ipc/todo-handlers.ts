// IPC handlers for todo.* + progress.* channels.

import { BrowserWindow } from 'electron';
import { okResult, failResult, register } from './router';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import { logger } from '../logger';

/** Push a coarse-grained data-changed event so the renderer's todo / list /
 *  stats hooks re-fetch after a mutation the user just made here (mirrors the
 *  AI-tool broadcast in ai-handlers, but for direct user IPC like progress.log). */
function broadcastDataChanged(scope: 'todos' | 'content' | 'drawings' | 'conversations'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}

export function registerTodoHandlers(repo: TodoRepo, md: MarkdownStore): void {
  register('todo.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.list(req.filter ?? {})));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('todo.get', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.get(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('get_failed', (err as Error).message));
    }
  });

  register('todo.create', (_e, req) => {
    try {
      const todo = repo.create(req.input, md.filePathFor('placeholder'));
      md.writeBody(todo.id, '');
      const fresh = repo.get(todo.id)!;
      return Promise.resolve(okResult({ id: todo.id, todo: fresh }));
    } catch (err) {
      return Promise.resolve(failResult('create_failed', (err as Error).message));
    }
  });

  register('todo.update', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.update(req.id, req.patch)));
    } catch (err) {
      return Promise.resolve(failResult('update_failed', (err as Error).message));
    }
  });

  register('todo.delete', (_e, req) => {
    try {
      repo.delete(req.id);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('delete_failed', (err as Error).message));
    }
  });

  register('todo.restore', (_e, req) => {
    try {
      repo.restore(req.id);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('restore_failed', (err as Error).message));
    }
  });

  register('todo.batchUpdate', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.batchUpdate(req.ids, req.patch)));
    } catch (err) {
      return Promise.resolve(failResult('batch_failed', (err as Error).message));
    }
  });

  register('todo.search', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.search(req.query, req.limit ?? 50)));
    } catch (err) {
      return Promise.resolve(failResult('search_failed', (err as Error).message));
    }
  });

  register('todo.stats', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.stats(req.windowDays ?? 7)));
    } catch (err) {
      return Promise.resolve(failResult('stats_failed', (err as Error).message));
    }
  });

  register('progress.log', (_e, req) => {
    try {
      const result = repo.logProgress(req.todoId, req.percent, req.note);
      // The todos.progress column changed — broadcast so the editor's todo
      // object (progress bar) and any list view refresh.
      broadcastDataChanged('todos');
      return Promise.resolve(okResult(result));
    } catch (err) {
      return Promise.resolve(failResult('progress_log_failed', (err as Error).message));
    }
  });

  register('progress.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.listProgress(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('progress_list_failed', (err as Error).message));
    }
  });

  logger.info('todo.* + progress.* handlers registered');
}