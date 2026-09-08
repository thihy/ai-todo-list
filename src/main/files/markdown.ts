// Markdown file storage. Each TODO has a .md file with YAML front-matter + Markdown body.
// DB is the authority; the file is projected. Version history kept in DB content_versions.

import type Database from 'better-sqlite3';
import matter from 'gray-matter';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ContentVersionEntry, Priority, TodoStatus, ULID } from '../../shared/todo-types';
import { MAX_BODY_VERSIONS } from '../../shared/constants';

interface FrontMatter {
  id: ULID;
  title: string;
  status: TodoStatus;
  priority: Priority;
  project: string | null;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

export class MarkdownStore {
  constructor(
    private db: Database.Database,
    private todosDir: string,
  ) {
    mkdirSync(todosDir, { recursive: true });
  }

  filePathFor(id: ULID): string {
    return join(this.todosDir, `${id}.md`);
  }

  readBody(id: ULID): { markdown: string; version: number } {
    const path = this.filePathFor(id);
    let body = '';
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const parsed = matter(raw);
      body = parsed.content.trimStart();
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

  writeBody(id: ULID, markdown: string, expectVersion?: number): { version: number; updatedAt: number } {
    const todo = this.db
      .prepare<[ULID], {
        id: string;
        title: string;
        status: TodoStatus;
        priority: Priority;
        project: string | null;
        due_at: number | null;
        created_at: number;
      }>(
        'SELECT id, title, status, priority, project, due_at, created_at FROM todos WHERE id = ?',
      )
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
    const tags = this.db
      .prepare<[ULID], { tag: string }>('SELECT tag FROM tags WHERE todo_id = ?')
      .all(id)
      .map((r) => r.tag);

    const fm: FrontMatter = {
      id: todo.id,
      title: todo.title,
      status: todo.status,
      priority: todo.priority,
      project: todo.project,
      dueAt: todo.due_at,
      createdAt: todo.created_at,
      updatedAt: now,
      tags,
    };
    const content = matter.stringify(markdown.startsWith('\n') ? markdown : `\n${markdown}`, fm);
    const path = this.filePathFor(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO content_versions (todo_id, body, saved_at) VALUES (?, ?, ?)`,
        )
        .run(id, markdown, now);
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
        .run(markdown, now, id);
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