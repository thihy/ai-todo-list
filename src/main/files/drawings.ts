// Excalidraw drawing file storage. JSON scene + optional PNG thumb.
//
// Per-task layout (post-refactor):
//
//   {dataDir}/todos/{slug}/
//     {drawingSlug}.excalidraw   ← JSON scene (filename from title)
//     thumbs/{drawingId}.thumb.png
//
// The DB row's `path` column stores the title-slug filename; full path is
// resolved via resolveTaskDir(todoId). `thumb_path` is the thumbs-relative
// path. Both columns are taskDir-relative — they survive the rename-dir hook
// (Commit 6) which only moves the whole per-task folder.

import type Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../db/schema';
import type { DrawingMeta, ULID } from '../../shared/todo-types';
import { drawingFile, slugify, thumbFile } from './paths';
import { logger } from '../logger';

export class DrawingStore {
  constructor(
    private db: Database.Database,
    /**
     * Used solely for the legacy `drawingsDir` accessor below (kept for
     * backwards compat with tests that just want a base directory). The new
     * file path lives inside each task dir.
     */
    private drawingsDir: string,
    private resolveTaskDir: (todoId: ULID) => string,
  ) {
    mkdirSync(drawingsDir, { recursive: true });
  }

  /** Resolve on each operation so a successful task-directory rename is
   * observed immediately. The injected resolver is stable via SQLite. */
  private taskDirFor(todoId: ULID): string {
    return this.resolveTaskDir(todoId);
  }

  /** Legacy accessor — kept so external callers (git-history, tests) can
   *  still find the parent directory of all drawing files. After Commit 9,
   *  git-history will switch to per-task dirs and this accessor goes away. */
  get baseDir(): string {
    return this.drawingsDir;
  }

  list(todoId: ULID): DrawingMeta[] {
    return this.db
      .prepare<[ULID], {
        id: string;
        todo_id: string;
        title: string | null;
        thumb_path: string | null;
        created_at: number;
        updated_at: number;
      }>(
        'SELECT id, todo_id, title, thumb_path, created_at, updated_at FROM drawings WHERE todo_id = ? ORDER BY updated_at DESC',
      )
      .all(todoId)
      .map((r) => ({
        id: r.id,
        todoId: r.todo_id,
        title: r.title,
        thumbPath: r.thumb_path,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Single drawing meta by id (for rename return value). Null if missing. */
  get(id: ULID): DrawingMeta | null {
    const r = this.db
      .prepare<[ULID], {
        id: string;
        todo_id: string;
        title: string | null;
        thumb_path: string | null;
        created_at: number;
        updated_at: number;
      }>(
        'SELECT id, todo_id, title, thumb_path, created_at, updated_at FROM drawings WHERE id = ?',
      )
      .get(id);
    if (!r) return null;
    return {
      id: r.id,
      todoId: r.todo_id,
      title: r.title,
      thumbPath: r.thumb_path,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  read(id: ULID): unknown {
    const row = this.db
      .prepare<[ULID], { todo_id: string; title: string | null }>(
        'SELECT todo_id, title FROM drawings WHERE id = ?',
      )
      .get(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const taskDir = this.taskDirFor(row.todo_id);
    const fp = drawingFile(taskDir, row.title ?? '');
    if (!existsSync(fp)) throw new Error(`drawing_file_missing: ${fp}`);
    return JSON.parse(readFileSync(fp, 'utf8'));
  }

  save(todoId: ULID, scene: unknown, id?: ULID, title?: string): DrawingMeta {
    const drawingId = id ?? newId();
    const now = Date.now();
    const taskDir = this.taskDirFor(todoId);
    const fullPath = drawingFile(taskDir, title ?? '');
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(scene), 'utf8');
    // path column is taskDir-relative — just the title-slug filename.
    const relPath = `${slugifyForPath(title ?? '')}.excalidraw`;

    const existing = this.db
      .prepare<[ULID], { id: string; title: string | null; path: string }>(
        'SELECT id, title, path FROM drawings WHERE id = ?',
      )
      .get(drawingId);

    if (existing) {
      // Title change → rename on disk before updating DB so a failure leaves
      // the DB row pointing at the still-existing old file.
      const oldTitle = existing.title ?? '';
      const newTitle = title ?? '';
      if (oldTitle !== newTitle) {
        this.bestEffortRenameFile(taskDir, oldTitle, newTitle);
      }
      this.db
        .prepare('UPDATE drawings SET title = ?, path = ?, updated_at = ? WHERE id = ?')
        .run(newTitle || null, relPath, now, drawingId);
    } else {
      this.db
        .prepare(
          'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(drawingId, todoId, title ?? null, relPath, now, now);
    }

    const after = this.get(drawingId)!;
    return after;
  }

  delete(id: ULID): void {
    // Capture file paths BEFORE the row goes away so we can still clean them
    // up if the unlink fails.
    const row = this.db
      .prepare<[ULID], { todo_id: string; title: string | null }>(
        'SELECT todo_id, title FROM drawings WHERE id = ?',
      )
      .get(id);
    this.db.prepare('DELETE FROM drawings WHERE id = ?').run(id);
    if (row) {
      const taskDir = this.taskDirFor(row.todo_id);
      this.bestEffortUnlink(drawingFile(taskDir, row.title ?? ''));
      this.bestEffortUnlink(thumbFile(taskDir, id));
    }
  }

  /** Rename a drawing's title. Best-effort file rename; failure is logged
   *  but does not abort — the DB row always reflects the new title. */
  rename(id: ULID, title: string): void {
    const trimmed = title.trim();
    const before = this.db
      .prepare<[ULID], { todo_id: string; title: string | null }>(
        'SELECT todo_id, title FROM drawings WHERE id = ?',
      )
      .get(id);
    if (!before) return;
    const oldTitle = before.title ?? '';
    const newTitle = trimmed || null;
    this.db
      .prepare('UPDATE drawings SET title = ?, path = ?, updated_at = ? WHERE id = ?')
      .run(newTitle, `${slugifyForPath(trimmed)}.excalidraw`, Date.now(), id);
    if (oldTitle !== trimmed) {
      this.bestEffortRenameFile(this.taskDirFor(before.todo_id), oldTitle, trimmed);
    }
  }

  setThumb(id: ULID, dataUrl: string): void {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const row = this.db
      .prepare<[ULID], { todo_id: string }>('SELECT todo_id FROM drawings WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const taskDir = this.taskDirFor(row.todo_id);
    const fullPath = thumbFile(taskDir, id);
    const thumbRelPath = `thumbs/${id}.thumb.png`;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    this.db
      .prepare('UPDATE drawings SET thumb_path = ? WHERE id = ?')
      .run(thumbRelPath, id);
  }

  // --- helpers -----------------------------------------------------------

  private bestEffortRenameFile(taskDir: string, oldTitle: string, newTitle: string): void {
    try {
      const oldPath = drawingFile(taskDir, oldTitle);
      const newPath = drawingFile(taskDir, newTitle);
      if (existsSync(oldPath) && oldPath !== newPath) renameSync(oldPath, newPath);
    } catch (err) {
      logger.warn(`DrawingStore best-effort rename failed: ${(err as Error).message}`);
    }
  }

  private bestEffortUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      logger.warn(`DrawingStore best-effort unlink failed: ${(err as Error).message}`);
    }
  }
}

// `drawingFile(taskDir, title)` already slugifies the title for the filename,
// but the DB `path` column stores the same filename as a stable reference —
// derive it once via the shared slugify() to keep file path and DB row in
// lockstep.
function slugifyForPath(title: string): string {
  return slugify(title);
}
