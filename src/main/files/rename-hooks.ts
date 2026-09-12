// Rename hooks — best-effort per-task file moves when a TODO or one of its
// documents gets renamed. The DB is the source of truth and is always updated
// first; on-disk moves are fire-and-forget so a transient filesystem error
// (locked file, missing parent, permissions) doesn't roll back the rename.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as paths from './paths';
import { logger } from '../logger';
import { TaskDirectoryStore } from './task-directories';

/** Rename a task's per-task directory + rewrite inbox_attachments.file_path
 *  rows that lived under the old dir to point at the new dir. All file ops
 *  are best-effort: any failure is logged + swallowed so the caller's DB
 *  update (which has already happened) isn't rolled back.
 *
 *  Returns whether the on-disk rename succeeded — useful for tests. The DB
 *  path rewrite always runs (because the DB has the new title and the old
 *  absolute paths are now stale regardless of the file move). */
export function renameTaskDir(opts: {
  db: Database.Database;
  todosDir: string;
  todoId: string;
  oldTitle: string;
  newTitle: string;
  taskDirectories?: TaskDirectoryStore;
}): { dirRenamed: boolean; pathsUpdated: number } {
  const { db, todoId, newTitle } = opts;
  const taskDirectories = opts.taskDirectories ?? new TaskDirectoryStore(db, opts.todosDir);
  const move = taskDirectories.rename(todoId, newTitle);

  // Rewrite inbox_attachments.file_path rows that pointed under oldDir so
  // they point under the (possibly new) dir. Without this, attachments
  // created before a rename would dangle on disk and the attachment://
  // protocol would 404 on them.
  const pathsUpdated = move.dirRenamed
    ? rewriteInboxPaths(db, todoId, move.oldDir, move.newDir)
    : 0;

  return { dirRenamed: move.dirRenamed, pathsUpdated };
}

function rewriteInboxPaths(
  db: Database.Database,
  todoId: string,
  oldDir: string,
  newDir: string,
): number {
  if (oldDir === newDir) return 0;
  const oldPrefix = join(oldDir, 'attachments') + (oldDir.includes('\\') ? '\\' : '/');
  const rows = db
    .prepare<[string], { id: string; file_path: string }>(
      'SELECT id, file_path FROM inbox_attachments WHERE todo_id = ?',
    )
    .all(todoId);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.file_path.startsWith(oldPrefix)) continue;
      const remainder = row.file_path.slice(oldPrefix.length);
      const next = join(newDir, 'attachments', remainder);
      db.prepare('UPDATE inbox_attachments SET file_path = ? WHERE id = ?').run(next, row.id);
      updated++;
    }
  });
  tx();
  return updated;
}

/** Write a snapshot of a task's metadata to {taskDir}/todo.json. Best-effort;
 *  the DB is authoritative and the file is a backup for file explorer + git. */
export function writeTodoJson(
  taskDir: string,
  todo: { id: string; title: string; status: string; priority: string; tags: string[]; dueAt: number | null; createdAt: number; updatedAt: number; doneAt: number | null; plannedFor: string | null },
): void {
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      paths.todoJsonPath(taskDir),
      JSON.stringify(todo, null, 2),
      'utf8',
    );
  } catch (err) {
    logger.warn(`writeTodoJson(${taskDir}) failed: ${(err as Error).message}`);
  }
}
