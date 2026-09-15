import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { TaskDirectoryStore } from '../../src/main/files/task-directories';

describe('TaskDirectoryStore', () => {
  let root: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let dirs: TaskDirectoryStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'todo-dirs-'));
    handle = openDb(join(root, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    dirs = new TaskDirectoryStore(handle.db, join(root, 'todos'));
  });

  afterEach(() => {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists a prefixed association and returns it on every resolve', () => {
    const todo = repo.create({ title: '同名任务' }, 'x');
    const first = dirs.resolve(todo.id);
    const second = dirs.resolve(todo.id);
    expect(first).toBe(second);
    expect(basename(first)).toBe(`${todo.id.slice(0, 6)}-同名任务`);
    const row = handle.db
      .prepare<[string], { storage_dir: string }>('SELECT storage_dir FROM todos WHERE id = ?')
      .get(todo.id);
    expect(row?.storage_dir).toBe(basename(first));
  });

  it('updates the association only when a directory rename succeeds', () => {
    const todo = repo.create({ title: 'Old' }, 'x');
    const oldDir = dirs.resolve(todo.id);
    writeFileSync(join(oldDir, 'progress.md'), '<p>saved</p>');
    const moved = dirs.rename(todo.id, 'New');
    expect(moved.dirRenamed).toBe(true);
    expect(dirs.resolve(todo.id)).toBe(moved.newDir);
    expect(existsSync(join(moved.newDir, 'progress.md'))).toBe(true);

    // Occupied target makes the rename fail; association remains on New.
    const blockedTarget = join(root, 'todos', `${todo.id.slice(0, 6)}-Blocked`);
    mkdirSync(blockedTarget);
    const failed = dirs.rename(todo.id, 'Blocked');
    expect(failed.dirRenamed).toBe(false);
    expect(dirs.resolve(todo.id)).toBe(moved.newDir);
  });
});
