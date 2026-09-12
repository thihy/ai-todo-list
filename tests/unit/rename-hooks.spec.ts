// Rename-hook tests — best-effort task-dir rename on todo.update.
//
// Locks the contract that renaming a task:
//   1. Always updates the DB title (already handled by TodoRepo.update).
//   2. Best-effort moves the per-task directory to the new slug.
//   3. Always rewrites inbox_attachments.file_path rows that lived under
//      the old dir so they don't dangle after a rename.
//   4. Never throws — a failed rename is logged + swallowed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { renameTaskDir, writeTodoJson } from '../../src/main/files/rename-hooks';
import * as paths from '../../src/main/files/paths';

describe('renameTaskDir', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-rename-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves the per-task directory when the slug changes', () => {
    const t = repo.create({ title: 'Old' }, 'x');
    const oldDir = paths.todoDir(todosDir, 'Old', t.id);
    writeFileSync(join(oldDir, 'progress.html'), '<p>x</p>', 'utf8');
    expect(existsSync(oldDir)).toBe(true);

    const result = renameTaskDir({
      db: handle.db,
      todosDir,
      todoId: t.id,
      oldTitle: 'Old',
      newTitle: 'New',
    });

    expect(result.dirRenamed).toBe(true);
    expect(result.pathsUpdated).toBe(0);
    // The task id prefix keeps same-title directories collision-free.
    const expectedNewDir = join(todosDir, `${t.id.slice(0, 6)}-New`);
    expect(existsSync(expectedNewDir)).toBe(true);
    expect(existsSync(join(expectedNewDir, 'progress.html'))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('rewrites inbox_attachments.file_path to the new dir', () => {
    const t = repo.create({ title: 'A' }, 'x');
    const oldDir = paths.todoDir(todosDir, 'A', t.id);
    mkdirSync(join(oldDir, 'attachments'), { recursive: true });
    const attPath = join(oldDir, 'attachments', '01abc-note.txt');
    writeFileSync(attPath, 'data', 'utf8');
    handle.db
      .prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('01abc', t.id, attPath, 'text/plain', Date.now());

    const result = renameTaskDir({
      db: handle.db,
      todosDir,
      todoId: t.id,
      oldTitle: 'A',
      newTitle: 'B',
    });

    expect(result.dirRenamed).toBe(true);
    expect(result.pathsUpdated).toBe(1);
    const row = handle.db
      .prepare<[string], { file_path: string }>('SELECT file_path FROM inbox_attachments WHERE id = ?')
      .get('01abc');
    const expectedNewDir = join(todosDir, `${t.id.slice(0, 6)}-B`);
    expect(row!.file_path).toBe(join(expectedNewDir, 'attachments', '01abc-note.txt'));
  });

  it('is a no-op when the slug does not change', () => {
    const t = repo.create({ title: 'Same' }, 'x');
    const dir = paths.todoDir(todosDir, 'Same', t.id);
    writeFileSync(join(dir, 'progress.html'), '<p>x</p>', 'utf8');
    const result = renameTaskDir({
      db: handle.db,
      todosDir,
      todoId: t.id,
      oldTitle: 'Same',
      newTitle: 'Same',
    });
    expect(result.dirRenamed).toBe(false);
    expect(result.pathsUpdated).toBe(0);
    expect(existsSync(join(dir, 'progress.html'))).toBe(true);
  });

  it('never throws on a missing old dir', () => {
    const t = repo.create({ title: 'Ghost' }, 'x');
    // The old dir was never created (e.g. the task had no on-disk files yet).
    expect(() =>
      renameTaskDir({
        db: handle.db,
        todosDir,
        todoId: t.id,
        oldTitle: 'Ghost',
        newTitle: 'Spirit',
      }),
    ).not.toThrow();
  });
});

describe('writeTodoJson', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-todojson-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a JSON snapshot to {taskDir}/todo.json', () => {
    const taskDir = join(dir, 'T');
    writeTodoJson(taskDir, {
      id: '01ABC',
      title: 'T',
      status: 'next',
      priority: 'none',
      tags: [],
      dueAt: null,
      createdAt: 1,
      updatedAt: 2,
      doneAt: null,
      plannedFor: null,
    });
    const path = paths.todoJsonPath(taskDir);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.id).toBe('01ABC');
    expect(parsed.title).toBe('T');
  });
});
