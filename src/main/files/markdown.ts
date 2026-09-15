// Progress doc file storage. Per-task layout (post-refactor):
//
//   {dataDir}/todos/{slug}/progress.md      ← Markdown (no front-matter)
//
// DB is still the authority: `todos.body` (mirror for FTS5 snippets) and
// `content_versions.body` (version history). The file is a write-through
// projection so other tools (git history, file explorer) can see it without
// opening the DB.

import type Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { ContentVersionEntry, ULID } from '../../shared/todo-types';
import { MAX_BODY_VERSIONS } from '../../shared/constants';
import { progressFile } from './paths';

export class MarkdownStore {
  constructor(
    private db: Database.Database,
    private todosDir: string,
    /** Resolve the per-task directory for a given TODO id. Injected at
     *  construction time so this store stays DB-only — title lookups live in
     *  the wiring layer. */
    private resolveTaskDir: (id: ULID) => string,
  ) {
    mkdirSync(todosDir, { recursive: true });
  }

  /** Absolute path to the folder that holds the per-task sub-directories.
   *  Used by git-history wiring (commitOnSave, getFileLog, …) as the `.git/`
   *  parent. The per-task dir itself is resolved via `resolveTaskDir(id)`. */
  get todosDirPath(): string {
    return this.todosDir;
  }

  /** The per-task dir for a given id. Compat helper — git-history treats
   *  this as the dir that owns the file. After Commit 9, callers will pass
   *  the taskDir explicitly. */
  filePathFor(id: ULID): string {
    return this.taskDirFor(id);
  }

  /** Internal: the DB-backed resolver is deterministic and follows a
   * successful task-directory rename immediately. */
  private taskDirFor(id: ULID): string {
    return this.resolveTaskDir(id);
  }

  readBody(id: ULID): { markdown: string; version: number } {
    const path = progressFile(this.taskDirFor(id));
    let body = '';
    if (existsSync(path)) {
      body = readFileSync(path, 'utf8');
    }
    const version = (
      this.db
        .prepare<[ULID], { v: number | null }>(
          'SELECT MAX(id) as v FROM content_versions WHERE todo_id = ?',
        )
        .get(id)
    )?.v ?? 0;
    return { markdown: body, version };
  }

  writeBody(id: ULID, html: string, expectVersion?: number): { version: number; updatedAt: number } {
    const todo = this.db
      .prepare<[ULID], { id: string }>('SELECT id FROM todos WHERE id = ?')
      .get(id);
    if (!todo) throw new Error(`todo_not_found: ${id}`);

    if (expectVersion != null) {
      const current = (
        this.db
          .prepare<[ULID], { v: number | null }>(
            'SELECT MAX(id) as v FROM content_versions WHERE todo_id = ?',
          )
          .get(id)
      )?.v ?? 0;
      if (current !== expectVersion) {
        throw new Error(`version_conflict: expected ${expectVersion}, current ${current}`);
      }
    }

    const now = Date.now();
    const taskDir = this.taskDirFor(id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(progressFile(taskDir), html, 'utf8');

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO content_versions (todo_id, body, saved_at) VALUES (?, ?, ?)`,
        )
        .run(id, html, now);
      // Trim to MAX_BODY_VERSIONS, keeping newest.
      this.db
        .prepare(
          `DELETE FROM content_versions
           WHERE todo_id = ? AND id NOT IN (
             SELECT id FROM content_versions WHERE todo_id = ? ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(id, id, MAX_BODY_VERSIONS);
      // Mirror current body onto the todos row so the FTS5 external-content
      // table has non-empty body text for snippet() to highlight.
      this.db
        .prepare(`UPDATE todos SET body = ?, updated_at = ? WHERE id = ?`)
        .run(html, now, id);
    });
    tx();

    const version = (
      this.db
        .prepare<[ULID], { v: number | null }>(
          'SELECT MAX(id) as v FROM content_versions WHERE todo_id = ?',
        )
        .get(id)
    )?.v ?? 0;

    return { version, updatedAt: now };
  }

  history(id: ULID): ContentVersionEntry[] {
    return this.db
      .prepare<[ULID], { id: number; todo_id: string; body: string; saved_at: number }>(
        'SELECT id, todo_id, body, saved_at FROM content_versions WHERE todo_id = ? ORDER BY saved_at DESC',
      )
      .all(id)
      .map((r) => ({ id: r.id, todoId: r.todo_id, body: r.body, savedAt: r.saved_at }));
  }

  restoreVersion(id: ULID, versionId: number): void {
    const v = this.db
      .prepare<[ULID, number], { body: string }>(
        'SELECT body FROM content_versions WHERE todo_id = ? AND id = ?',
      )
      .get(id, versionId);
    if (!v) throw new Error(`version_not_found: ${versionId}`);
    this.writeBody(id, v.body);
  }
}
