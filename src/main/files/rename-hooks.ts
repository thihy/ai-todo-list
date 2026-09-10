// Rename hooks — best-effort per-task file moves when a TODO or one of its
// documents gets renamed. The DB is the source of truth and is always updated
// first; on-disk moves are fire-and-forget so a transient filesystem error
// (locked file, missing parent, permissions) doesn't roll back the rename.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as paths from './paths';
import { logger } from '../logger';

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
}): { dirRenamed: boolean; pathsUpdated: number } {
  const { db, todosDir, todoId, oldTitle, newTitle } = opts;
  const oldSlug = paths.slugify(oldTitle || paths.UNTITLED_SLUG);
  const newSlug = paths.slugify(newTitle || paths.UNTITLED_SLUG);
  const slugChanged = oldSlug !== newSlug;
  // Find the EXACT old dir on disk. uniqueTodoDir is unstable: the first
  // call returns {todosDir}/{slug} (dir didn't exist), but subsequent calls
  // return {todosDir}/{slug}-{suffix} because the dir now exists. The
  // original file lives at whichever path was chosen on first access, so
  // we probe both candidates and pick the one that actually exists.
  const oldDir = resolveExistingTaskDir(todosDir, oldSlug, todoId);
  const newDirCandidate = paths.uniqueTodoDir(todosDir, newSlug, todoId);

  let dirRenamed = false;
  if (slugChanged && oldDir && oldDir !== newDirCandidate) {
    try {
      // Windows fs.renameSync can't rename a directory onto an existing
      // destination (EPERM). Clean up the empty placeholder if our probe
      // created one, then let renameSync materialize the new path.
      if (existsSync(newDirCandidate)) {
        // Best-effort rmdir; the destination should be empty in this
        // branch because newSlug differs from oldSlug and no production
        // code creates the dir eagerly under the new name yet.
        try {
          // Use rmdirSync (no recursive) to avoid clobbering real content.
          const { rmdirSync } = require('node:fs') as typeof import('node:fs');
          rmdirSync(newDirCandidate);
        } catch {
          /* swallow — let renameSync attempt; its failure is also logged */
        }
      }
      renameSync(oldDir, newDirCandidate);
      dirRenamed = true;
    } catch (err) {
      logger.warn(`renameTaskDir: failed to rename ${oldDir} → ${newDirCandidate}: ${(err as Error).message}`);
    }
  }

  // Rewrite inbox_attachments.file_path rows that pointed under oldDir so
  // they point under the (possibly new) dir. Without this, attachments
  // created before a rename would dangle on disk and the attachment://
  // protocol would 404 on them.
  const pathsUpdated = oldDir
    ? rewriteInboxPaths(db, todoId, oldDir, newDirCandidate)
    : 0;

  return { dirRenamed, pathsUpdated };
}

/** Return whichever of the two candidate paths actually exists on disk —
 *  {todosDir}/{slug} wins, else {todosDir}/{slug}-{ulidSuffix}. Null if
 *  neither exists. */
function resolveExistingTaskDir(todosDir: string, slug: string, ulid: string): string | null {
  const unsuffixed = join(todosDir, slug);
  if (existsSync(unsuffixed)) return unsuffixed;
  const suffixed = join(todosDir, `${slug}-${ulid.slice(-4)}`);
  if (existsSync(suffixed)) return suffixed;
  return null;
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
  todo: { id: string; title: string; status: string; priority: string; tags: string[]; project: string | null; dueAt: number | null; createdAt: number; updatedAt: number; doneAt: number | null },
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
