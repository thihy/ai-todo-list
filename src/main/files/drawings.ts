// Excalidraw drawing file storage. JSON scene + optional PNG thumb.

import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../db/schema';
import type { DrawingMeta, ULID } from '../../shared/todo-types';

export class DrawingStore {
  constructor(
    private db: Database.Database,
    private drawingsDir: string,
  ) {
    mkdirSync(drawingsDir, { recursive: true });
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
      .prepare<[ULID], { path: string }>('SELECT path FROM drawings WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const fp = join(this.drawingsDir, row.path);
    if (!existsSync(fp)) throw new Error(`drawing_file_missing: ${row.path}`);
    return JSON.parse(readFileSync(fp, 'utf8'));
  }

  save(todoId: ULID, scene: unknown, id?: ULID, title?: string): DrawingMeta {
    const drawingId = id ?? newId();
    const now = Date.now();
    const relPath = join(todoId, `${drawingId}.excalidraw`);
    const fullPath = join(this.drawingsDir, relPath);
    mkdirSync(join(this.drawingsDir, todoId), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(scene), 'utf8');

    const existing = this.db
      .prepare<[ULID], { id: string }>('SELECT id FROM drawings WHERE id = ?')
      .get(drawingId);

    if (existing) {
      this.db
        .prepare('UPDATE drawings SET title = ?, path = ?, updated_at = ? WHERE id = ?')
        .run(title ?? null, relPath, now, drawingId);
    } else {
      this.db
        .prepare(
          'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(drawingId, todoId, title ?? null, relPath, now, now);
    }

    return {
      id: drawingId,
      todoId,
      title: title ?? null,
      thumbPath: null,
      createdAt: existing ? now : now,
      updatedAt: now,
    };
  }

  delete(id: ULID): void {
    this.db.prepare('DELETE FROM drawings WHERE id = ?').run(id);
  }

  /** Rename a drawing's title only (no scene rewrite). Mirrors
   *  DocumentStore.rename so tabs of either kind are renamable inline. */
  rename(id: ULID, title: string): void {
    const trimmed = title.trim();
    this.db
      .prepare('UPDATE drawings SET title = ?, updated_at = ? WHERE id = ?')
      .run(trimmed || null, Date.now(), id);
  }

  setThumb(id: ULID, dataUrl: string): void {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const row = this.db
      .prepare<[ULID], { path: string }>('SELECT path FROM drawings WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const thumbRelPath = row.path.replace(/\.excalidraw$/, '.thumb.png');
    const fullPath = join(this.drawingsDir, thumbRelPath);
    mkdirSync(join(this.drawingsDir, 'thumbs'), { recursive: true });
    writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    this.db
      .prepare('UPDATE drawings SET thumb_path = ? WHERE id = ?')
      .run(thumbRelPath, id);
  }
}