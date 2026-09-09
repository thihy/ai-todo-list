// IPC handlers for todo.* channels.

import { okResult, failResult, register } from './router';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import { logger } from '../logger';

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

  logger.info('todo.* handlers registered');
}