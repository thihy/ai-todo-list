// Markdown store: writeBody / history / restoreVersion trimming at MAX_BODY_VERSIONS.
// Post-refactor: writes to {todosDir}/{slug}/progress.html.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { MarkdownStore } from '../../src/main/files/markdown';
import { openDb } from '../../src/main/db/schema';
import * as paths from '../../src/main/files/paths';
import Database from 'better-sqlite3';

let db: Database.Database;
let dir: string;
let md: MarkdownStore;
let todosDir: string;
let resolveTaskDir: (id: string) => string;

/** Insert a TODO row so MarkdownStore.writeBody's `todo_not_found` check passes. */
function seedTodo(id: string, title = 'test'): void {
  db.prepare(
    `INSERT INTO todos (id, title, status, priority, project, due_at, body_path, created_at, updated_at, done_at)
     VALUES (?, ?, 'next', 'none', NULL, NULL, ?, ?, ?, NULL)`,
  ).run(id, title, `${id}.md`, Date.now(), Date.now());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-list-md-'));
  const handle = openDb(join(dir, 't.db'));
  db = handle.db;
  todosDir = join(dir, 'todos');
  // Match the production wiring in index.ts: title comes from the DB row, with
  // UNTITLED_SLUG as a fallback for orphan ids.
  resolveTaskDir = (id: string) => {
    const row = db
      .prepare<[string], { title: string }>('SELECT title FROM todos WHERE id = ?')
      .get(id);
    return paths.todoDir(todosDir, row?.title ?? paths.UNTITLED_SLUG, id);
  };
  md = new MarkdownStore(db, todosDir, resolveTaskDir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MarkdownStore', () => {
  it('writes a body to {slug}/progress.html and reads it back', () => {
    seedTodo('todo1', 'hello');
    const res = md.writeBody('todo1', '# Hello', undefined);
    expect(res.version).toBe(1);
    expect(md.readBody('todo1').markdown.trimEnd()).toBe('# Hello');
    // The store caches the taskDir on first resolve so reads/writes share one
    // path even when the underlying uniqueTodoDir would otherwise append a
    // collision suffix on a second resolveTaskDir call.
    const taskDir = md.filePathFor('todo1' as never);
    expect(existsSync(join(taskDir, 'progress.html'))).toBe(true);
  });

  it('history grows on each write and trims at MAX_BODY_VERSIONS', () => {
    seedTodo('todo2');
    md.writeBody('todo2', 'v1', undefined);
    for (let i = 2; i <= 25; i++) {
      md.writeBody('todo2', `v${i}`, undefined);
    }
    const hist = md.history('todo2');
    expect(hist.length).toBeLessThanOrEqual(20);
  });

  it('restoreVersion rewinds body', () => {
    seedTodo('todo3');
    md.writeBody('todo3', 'a', undefined);
    md.writeBody('todo3', 'b', undefined);
    // history orders by saved_at DESC; pick the smallest id (= oldest row)
    // because Date.now() can collide within the same millisecond on fast
    // machines and the tiebreak leaves ordering implementation-defined.
    const h = md.history('todo3');
    const oldest = h.reduce((acc, v) => (v.id < acc.id ? v : acc));
    md.restoreVersion('todo3', oldest.id);
    expect(md.readBody('todo3').markdown.trimEnd()).toBe('a');
  });

  it('filePathFor returns the per-task dir', () => {
    const id = ulid();
    seedTodo(id);
    const p = md.filePathFor(id as never);
    expect(existsSync(dirname(p))).toBe(true);
    // filePathFor uses the cached taskDir so subsequent calls within the
    // store's lifetime always land on the same path. (Bare uniqueTodoDir
    // would append a collision suffix if called twice — the cache guards
    // against that.)
    expect(p).toBe(md.filePathFor(id as never));
  });
});

function dirname(p: string): string {
  return p.replace(/[/\\][^/\\]+$/, '');
}

// silence unused-import
void readdirSync;
void rmSync;