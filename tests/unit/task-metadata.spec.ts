import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { validateTaskMetadata } from '../../src/shared/task-metadata';

describe('task string KV metadata', () => {
  let directory: string; let handle: ReturnType<typeof openDb>; let repo: TodoRepo;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'task-kv-')); handle = openDb(join(directory, 'test.db')); repo = new TodoRepo(handle.db); });
  afterEach(() => { handle.close(); rmSync(directory, { recursive: true, force: true }); });
  it('persists custom values across create, unrelated updates, list and reopen, and supports clearing', () => {
    const metadata = { 客户: '某公司', 外部编号: '000123', 说明: '' };
    const todo = repo.create({ title: '任务', metadata });
    expect(todo.metadata).toEqual(metadata);
    repo.update(todo.id, { title: '新标题' });
    handle.close(); handle = openDb(join(directory, 'test.db')); repo = new TodoRepo(handle.db);
    expect(repo.list().find(row => row.id === todo.id)?.metadata).toEqual(metadata);
    expect(repo.update(todo.id, { metadata: { 来源: '自定义' } }).metadata).toEqual({ 来源: '自定义' });
    expect(repo.update(todo.id, { metadata: {} }).metadata).toEqual({});
  });
  it('rejects invalid values without mutating the task', () => {
    const todo = repo.create({ title: '默认' }); expect(todo.metadata).toEqual({});
    for (const value of [null, [], { '': '空键' }, { count: 1 }, { nested: {} }, JSON.parse('{"__proto__":"x"}'), { key: 'x'.repeat(10001) }]) {
      expect(() => repo.update(todo.id, { metadata: value as never })).toThrow();
      expect(repo.get(todo.id)?.metadata).toEqual({});
    }
    expect(() => validateTaskMetadata(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), 'v'])))).toThrow();
  });
});
