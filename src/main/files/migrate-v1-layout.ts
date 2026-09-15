// Boot-time sweep: migrate a pre-refactor (v1) data dir into the per-task
// layout (v2).
//
// v1 layout:
//   {dataDir}/todos/{ulid}.md             ← todo body (no front-matter post-gray-matter-removal)
//   {dataDir}/drawings/{ulid}/{drawingId}.excalidraw
//   {dataDir}/drawings/thumbs/{drawingId}.thumb.png
//   {dataDir}/inbox-attachments/{uuid}-{name}
//
// v2 layout (post-refactor):
//   {dataDir}/todos/{slug}/
//     todo.json
//     progress.md
//     {docTitle}.md | {drawingTitle}.excalidraw
//     thumbs/{drawingId}.thumb.png
//     attachments/{uuid}-{name}
//
// Idempotent: writes a marker file when done; subsequent boots return early.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import * as paths from './paths';
import { logger } from '../logger';
import * as gitHistory from '../git-history';

const MARKER_FILENAME = '.layout-migration-v1';

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  /** True when the sweep actually moved files; false when it was a no-op
   *  (already migrated, or no v1 files present). */
  didWork: boolean;
}

export interface MigrationOpts {
  dataDir: string;
  todosDir: string;
  /** Legacy flat drawings root. Migration moves files OUT of here. */
  drawingsDir: string;
  /** Legacy flat attachments root. Migration moves files OUT of here. */
  attachmentsDir: string;
  db: Database.Database;
  /** Fired when git mv operations actually happened, so the caller can
   *  commit a bridge commit (see plan §6). */
  onGitBridge?: (relpaths: string[]) => void | Promise<void>;
}

export async function migrateV1Layout(opts: MigrationOpts): Promise<MigrationResult> {
  const markerPath = join(opts.dataDir, MARKER_FILENAME);
  if (existsSync(markerPath)) {
    logger.info('migrateV1Layout: already migrated, skipping');
    return { migrated: 0, skipped: 0, failed: 0, didWork: false };
  }

  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0, didWork: false };
  const gitMovedRelpaths: string[] = [];

  // ---- Step 1: legacy {todosDir}/{ulid}.md → {todosDir}/{slug}/progress.md ----
  try {
    const legacyFiles = readdirSync(opts.todosDir).filter((f) => f.endsWith('.md'));
    for (const fname of legacyFiles) {
      const fullOld = join(opts.todosDir, fname);
      const ulid = fname.replace(/\.md$/, '');
      // The `todos` table stores one row per task with all scalar fields;
      // tags live in a separate `tags` table and are intentionally NOT
      // mirrored into todo.json here (the snapshot is best-effort metadata
      // for the file explorer + git — DB is the source of truth).
      const row = opts.db
        .prepare<[string], {
          title: string | null;
          status: string;
          priority: string;
          due_at: number | null;
          created_at: number;
          updated_at: number;
          done_at: number | null;
          parent_id: string | null;
          progress: number;
        }>(
          'SELECT title, status, priority, due_at, created_at, updated_at, done_at, parent_id, progress FROM todos WHERE id = ?',
        )
        .get(ulid);
      const title = row?.title ?? paths.UNTITLED_SLUG;
      // Detect "already migrated" at the UNSUFFIXED path. paths.todoDir uses
      // uniqueTodoDir, which suffixes once the unsuffixed dir exists — so
      // calling it here would resolve to a suffixed path and miss a
      // pre-existing todo.json at the unsuffixed path. Probe unsuffixed
      // first; only fall through to uniqueTodoDir (which handles a real
      // same-slug collision with another task) when the unsuffixed dir is
      // absent or lacks a todo.json.
      const unsuffixedDir = join(opts.todosDir, paths.slugify(title));
      if (existsSync(paths.todoJsonPath(unsuffixedDir))) {
        result.skipped++;
        continue; // already migrated
      }
      const taskDir = paths.todoDir(opts.todosDir, title, ulid);
      const todoJsonPath = paths.todoJsonPath(taskDir);
      if (existsSync(todoJsonPath)) {
        result.skipped++;
        continue; // suffixed target already migrated (rare collision case)
      }
      // Move the body file.
      const oldBody = readFileSync(fullOld, 'utf8');
      const newBodyPath = paths.progressFile(taskDir);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(newBodyPath, oldBody, 'utf8');
      rmSync(fullOld);
      // todo.json snapshot — keys mirror the shared `Todo` shape so a future
      // import path can re-hydrate the row verbatim. `tags` left as [] —
      // readers should consult the DB for the authoritative list.
      writeFileSync(
        todoJsonPath,
        JSON.stringify(
          {
            id: ulid,
            title,
            status: row?.status ?? 'next',
            priority: row?.priority ?? 'low',
            tags: [],
            dueAt: row?.due_at ?? null,
            createdAt: row?.created_at ?? Date.now(),
            updatedAt: row?.updated_at ?? Date.now(),
            doneAt: row?.done_at ?? null,
            parentId: row?.parent_id ?? null,
            progress: row?.progress ?? 0,
          },
          null,
          2,
        ),
        'utf8',
      );
      // git mv so history follows the file across the rename.
      try {
        const moved = await gitHistory.mv(opts.todosDir, fname, join(basename(taskDir), 'progress.md'));
        if (moved) gitMovedRelpaths.push(join(basename(taskDir), 'progress.md'));
      } catch (err) {
        logger.warn(`migrateV1Layout: git mv failed for ${fname}: ${(err as Error).message}`);
      }
      result.migrated++;
      result.didWork = true;
    }
  } catch (err) {
    logger.warn(`migrateV1Layout: todos sweep failed: ${(err as Error).message}`);
    result.failed++;
  }

  // ---- Step 2: legacy drawings/{todoId}/{drawingId}.excalidraw ----
  try {
    if (existsSync(opts.drawingsDir)) {
      const perTodo = readdirSync(opts.drawingsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const dirent of perTodo) {
        const todoId = dirent.name;
        const todoDir = paths.todoDir(opts.todosDir, opts.db
          .prepare<[string], { title: string | null }>('SELECT title FROM todos WHERE id = ?')
          .get(todoId)?.title ?? paths.UNTITLED_SLUG, todoId);
        const drawingFiles = readdirSync(join(opts.drawingsDir, todoId));
        for (const f of drawingFiles) {
          const oldPath = join(opts.drawingsDir, todoId, f);
          // thumbs go to thumbs/{drawingId}.thumb.png; scenes go to
          // {titleSlug}.excalidraw (rename via DB lookup below).
          let newPath: string;
          if (f.endsWith('.thumb.png')) {
            const drawingId = f.replace(/\.thumb\.png$/, '');
            newPath = paths.thumbFile(todoDir, drawingId);
          } else if (f.endsWith('.excalidraw')) {
            const drawingId = f.replace(/\.excalidraw$/, '');
            const meta = opts.db
              .prepare<[string], { title: string | null }>('SELECT title FROM drawings WHERE id = ?')
              .get(drawingId);
            newPath = paths.drawingFile(todoDir, meta?.title ?? '');
          } else {
            continue;
          }
          try {
            // Make the immediate parent of the destination (the task dir
            // itself, or its thumbs/ subdir) so renameSync doesn't ENOENT.
            mkdirSync(dirname(newPath), { recursive: true });
            renameSync(oldPath, newPath);
            result.migrated++;
            result.didWork = true;
          } catch (err) {
            logger.warn(`migrateV1Layout: drawing rename failed (${oldPath} → ${newPath}): ${(err as Error).message}`);
            result.failed++;
          }
        }
      }
    }
  } catch (err) {
    logger.warn(`migrateV1Layout: drawings sweep failed: ${(err as Error).message}`);
    result.failed++;
  }

  // ---- Step 3: legacy inbox-attachments/{uuid}-{name} → {taskDir}/attachments/ ----
  try {
    if (existsSync(opts.attachmentsDir)) {
      const files = readdirSync(opts.attachmentsDir);
      for (const f of files) {
        const oldPath = join(opts.attachmentsDir, f);
        // Look up which task owns this attachment.
        const row = opts.db
          .prepare<[string], { todo_id: string }>('SELECT todo_id FROM inbox_attachments WHERE file_path = ?')
          .get(oldPath);
        if (!row) {
          // Orphaned file: leave it; the next sweep won't find it either.
          continue;
        }
        const todoDir = paths.todoDir(opts.todosDir, opts.db
          .prepare<[string], { title: string | null }>('SELECT title FROM todos WHERE id = ?')
          .get(row.todo_id)?.title ?? paths.UNTITLED_SLUG, row.todo_id);
        const newPath = paths.attachmentFile(todoDir, f);
        try {
          renameSync(oldPath, newPath);
          opts.db.prepare('UPDATE inbox_attachments SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
          result.migrated++;
          result.didWork = true;
        } catch (err) {
          logger.warn(`migrateV1Layout: attachment rename failed (${oldPath} → ${newPath}): ${(err as Error).message}`);
          result.failed++;
        }
      }
    }
  } catch (err) {
    logger.warn(`migrateV1Layout: attachments sweep failed: ${(err as Error).message}`);
    result.failed++;
  }

  // ---- Step 4: git bridge commit (if any renames happened inside the repo) ----
  if (gitMovedRelpaths.length > 0 && opts.onGitBridge) {
    try {
      await opts.onGitBridge(gitMovedRelpaths);
    } catch (err) {
      logger.warn(`migrateV1Layout: git bridge commit failed: ${(err as Error).message}`);
    }
  }

  // ---- Step 5: write marker so we don't run again ----
  if (result.didWork) {
    writeFileSync(markerPath, new Date().toISOString(), 'utf8');
    logger.info(
      `migrateV1Layout: migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}`,
    );
  } else {
    // No files were moved. This covers two cases: a clean (post-migration)
    // data dir with zero v1 files, or every legacy file already skipped
    // because its target todo.json pre-existed. Either way the sweep is
    // done — write the marker so we don't re-scan on every boot.
    writeFileSync(markerPath, new Date().toISOString(), 'utf8');
    logger.info(
      `migrateV1Layout: nothing to move (skipped=${result.skipped}, failed=${result.failed}), marker written`,
    );
  }

  return result;
}
