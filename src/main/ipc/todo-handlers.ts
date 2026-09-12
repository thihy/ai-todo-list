// IPC handlers for todo.* + progress.* channels.

import { BrowserWindow } from 'electron';
import { okResult, failResult, register } from './router';
import type Database from 'better-sqlite3';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import { renameTaskDir, writeTodoJson } from '../files/rename-hooks';
import { logger } from '../logger';
import type { ULID } from '../../shared/todo-types';
import type { TaskDirectoryStore } from '../files/task-directories';

/** Push a coarse-grained data-changed event so the renderer's todo / list /
 *  stats hooks re-fetch after a mutation the user just made here (mirrors the
 *  AI-tool broadcast in ai-handlers, but for direct user IPC like progress.log). */
function broadcastDataChanged(scope: 'todos' | 'content' | 'drawings' | 'conversations'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}

export type ResolveTaskDir = (todoId: ULID) => string;

export function registerTodoHandlers(
  repo: TodoRepo,
  md: MarkdownStore,
  db: Database.Database,
  todosDir: string,
  resolveTaskDir: ResolveTaskDir,
  taskDirectories: TaskDirectoryStore,
): void {
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
      // Insert first; only then can the DB-backed directory resolver claim a
      // stable folder for the newly minted todo id.
      const todo = repo.create(req.input);
      md.writeBody(todo.id, '');
      // Best-effort write of the per-task todo.json snapshot. Failures are
      // logged but don't roll back the DB insert.
      const fresh = repo.get(todo.id)!;
      writeTodoJson(resolveTaskDir(todo.id), {
        id: fresh.id,
        title: fresh.title,
        status: fresh.status,
        priority: fresh.priority,
        tags: fresh.tags,
        dueAt: fresh.dueAt,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
        doneAt: fresh.doneAt,
        plannedFor: fresh.plannedFor,
      });
      broadcastDataChanged('todos');
      return Promise.resolve(okResult({ id: todo.id, todo: fresh }));
    } catch (err) {
      return Promise.resolve(failResult('create_failed', (err as Error).message));
    }
  });

  register('todo.update', (_e, req) => {
    try {
      // Capture old title BEFORE the DB update so the rename hook can move
      // the per-task dir to the new slug (best-effort).
      const before = repo.get(req.id);
      const oldTitle = before?.title ?? '';
      const titleChanged = typeof req.patch.title === 'string' && req.patch.title !== oldTitle;

      const updated = repo.update(req.id, req.patch);

      if (titleChanged && before) {
        const newTitle = updated.title ?? req.patch.title ?? '';
        const result = renameTaskDir({
          db,
          todosDir,
          todoId: req.id,
          oldTitle,
          newTitle,
          taskDirectories,
        });
        logger.info(
          `todo.update rename: dir=${result.dirRenamed ? 'moved' : 'unchanged'} inbox=${result.pathsUpdated}`,
        );
        // Always write the JSON snapshot to the (post-rename) taskDir, even
        // if the on-disk rename failed — the DB has the new title so the
        // snapshot belongs at the new path.
        const taskDir = resolveTaskDir(req.id);
        writeTodoJson(taskDir, {
          id: updated.id,
          title: updated.title,
          status: updated.status,
          priority: updated.priority,
          tags: updated.tags,
          dueAt: updated.dueAt,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          doneAt: updated.doneAt,
          plannedFor: updated.plannedFor,
        });
      } else if (before) {
        // Title didn't change but other fields might have — keep the JSON
        // snapshot fresh so the file mirror doesn't drift.
        const taskDir = resolveTaskDir(req.id);
        writeTodoJson(taskDir, {
          id: updated.id,
          title: updated.title,
          status: updated.status,
          priority: updated.priority,
          tags: updated.tags,
          dueAt: updated.dueAt,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          doneAt: updated.doneAt,
          plannedFor: updated.plannedFor,
        });
      }

      // Bidirectional refresh: an edit from the detail pane must refresh the
      // list, and an edit from the list row must refresh the detail. Both
      // useTodos and useTodo subscribe to the 'todos' data-version, so a
      // single broadcast here drives both. Without it, each side only sees
      // its own optimistic state and stays stale until re-selection.
      broadcastDataChanged('todos');
      return Promise.resolve(okResult(updated));
    } catch (err) {
      return Promise.resolve(failResult('update_failed', (err as Error).message));
    }
  });

  register('todo.delete', (_e, req) => {
    try {
      repo.delete(req.id);
      broadcastDataChanged('todos');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('delete_failed', (err as Error).message));
    }
  });

  register('todo.restore', (_e, req) => {
    try {
      repo.restore(req.id);
      broadcastDataChanged('todos');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('restore_failed', (err as Error).message));
    }
  });

  register('todo.batchUpdate', (_e, req) => {
    try {
      const res = okResult(repo.batchUpdate(req.ids, req.patch));
      broadcastDataChanged('todos');
      return Promise.resolve(res);
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

  register('progress.updateNote', (_e, req) => {
    try {
      const entry = repo.updateProgressNote(req.entryId, req.note);
      if (entry) broadcastDataChanged('todos');
      return Promise.resolve(okResult(entry));
    } catch (err) {
      return Promise.resolve(failResult('progress_update_note_failed', (err as Error).message));
    }
  });

  logger.info('todo.* + progress.* handlers registered');
}
