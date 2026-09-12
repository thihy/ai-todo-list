import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ULID } from '../../shared/todo-types';
import { logger } from '../logger';
import { slugify, todoJsonPath, UNTITLED_SLUG } from './paths';

interface TodoStorageRow {
  title: string;
  storage_dir: string | null;
}

/** Owns the durable todo-id -> directory association stored in SQLite. */
export class TaskDirectoryStore {
  constructor(
    private readonly db: Database.Database,
    private readonly todosDir: string,
  ) {}

  /** Resolve the associated directory. The first resolution claims a stable
   * DB value; every later resolution uses that value instead of recalculating
   * from the current title or from filesystem existence. */
  resolve(todoId: ULID): string {
    const row = this.row(todoId);
    if (!row) throw new Error(`todo_not_found: ${todoId}`);
    let dirName = row.storage_dir;
    if (!dirName) {
      dirName = this.findLegacyDir(todoId, row.title) ?? this.preferredName(todoId, row.title);
      this.db.prepare('UPDATE todos SET storage_dir = ? WHERE id = ?').run(dirName, todoId);
    }
    const dir = join(this.todosDir, basename(dirName));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Best-effort rename. The DB association changes only after the directory
   * move succeeds. On failure callers keep using the original directory. */
  rename(todoId: ULID, newTitle: string): { oldDir: string; newDir: string; dirRenamed: boolean } {
    const oldDir = this.resolve(todoId);
    const newDir = join(this.todosDir, this.preferredName(todoId, newTitle));
    if (oldDir === newDir) return { oldDir, newDir, dirRenamed: false };
    try {
      if (existsSync(newDir)) throw new Error(`destination_exists: ${newDir}`);
      renameSync(oldDir, newDir);
      this.db
        .prepare('UPDATE todos SET storage_dir = ? WHERE id = ?')
        .run(basename(newDir), todoId);
      return { oldDir, newDir, dirRenamed: true };
    } catch (err) {
      logger.warn(`TaskDirectoryStore.rename: failed to rename ${oldDir} -> ${newDir}: ${(err as Error).message}`);
      return { oldDir, newDir: oldDir, dirRenamed: false };
    }
  }

  private row(todoId: ULID): TodoStorageRow | undefined {
    return this.db
      .prepare<[ULID], TodoStorageRow>('SELECT title, storage_dir FROM todos WHERE id = ?')
      .get(todoId);
  }

  private preferredName(todoId: ULID, title: string): string {
    return `${todoId.slice(0, 6)}-${slugify(title || UNTITLED_SLUG)}`;
  }

  /** Adopt layouts produced by earlier releases instead of creating a second
   * directory. todo.json, when present, prevents claiming another task's
   * same-title legacy directory. */
  private findLegacyDir(todoId: ULID, title: string): string | null {
    const slug = slugify(title || UNTITLED_SLUG);
    const candidates = [
      this.preferredName(todoId, title),
      slug,
      `${slug}-${todoId.slice(-4)}`,
    ];
    for (const name of candidates) {
      const dir = join(this.todosDir, name);
      if (!existsSync(dir)) continue;
      try {
        const snapshot = JSON.parse(readFileSync(todoJsonPath(dir), 'utf8')) as { id?: string };
        if (snapshot.id && snapshot.id !== todoId) continue;
      } catch {
        // Old layouts may not have todo.json; adopt the only known candidate.
      }
      return name;
    }
    return null;
  }
}
