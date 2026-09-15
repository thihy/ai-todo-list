// ConversationRepo.deleteMany — 批量硬删。
//
// 行为契约：
//   - 数组为空或非数组 → 返回 0，不动 DB
//   - 单条 / 多条 → 返回实际 deleted 数（受存在性影响）
//   - 不存在的 id → 不算 deletion，返回 deleted = 实际存在且被删的数量
//   - 已归档也能删（deleteMany 是「硬删」语义，不区分 archived 标志；
//     sweep 才是「保留归档」的清理入口）
//   - 不动 JSONL（这是调用方职责；DB 行变化是正确的可观测信号）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { ConversationRepo } from '../../src/main/db/conversation-repo';

describe('ConversationRepo — deleteMany', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: ConversationRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-conv-delmany-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new ConversationRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insertRow = (
    id: string,
    updatedAt: number,
    archived: 0 | 1 = 0,
  ): void => {
    handle.db
      .prepare(
        'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, id, updatedAt, updatedAt, archived);
  };

  it('returns 0 for an empty array', () => {
    insertRow('a', 1);
    expect(repo.deleteMany([])).toBe(0);
    // DB 没动
    expect(repo.count(true)).toBe(1);
  });

  it('deletes a single id and returns 1', () => {
    insertRow('a', 1);
    insertRow('b', 2);
    expect(repo.deleteMany(['a'])).toBe(1);
    expect(repo.count(true)).toBe(1);
    expect(repo.list({ includeArchived: true }).map((c) => c.id)).toEqual(['b']);
  });

  it('deletes multiple ids and returns the exact count', () => {
    for (let i = 0; i < 5; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.deleteMany(['c-0', 'c-1', 'c-2'])).toBe(3);
    expect(repo.count(true)).toBe(2);
    expect(repo.list({ includeArchived: true }).map((c) => c.id).sort()).toEqual([
      'c-3',
      'c-4',
    ]);
  });

  it('counts only existing ids when some are missing', () => {
    insertRow('a', 1);
    insertRow('b', 2);
    // 'ghost' 不存在；'a' / 'b' 存在
    expect(repo.deleteMany(['a', 'ghost', 'b'])).toBe(2);
    expect(repo.count(true)).toBe(0);
  });

  it('returns 0 when every id is missing', () => {
    insertRow('a', 1);
    expect(repo.deleteMany(['x', 'y', 'z'])).toBe(0);
    expect(repo.count(true)).toBe(1);
  });

  it('deletes archived rows too (deleteMany is hard-delete)', () => {
    insertRow('keep', 1, 0);
    insertRow('hidden', 2, 1);
    expect(repo.deleteMany(['keep', 'hidden'])).toBe(2);
    expect(repo.count(true)).toBe(0);
  });

  it('does not touch rows outside the given ids', () => {
    for (let i = 0; i < 8; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.deleteMany(['c-2', 'c-5'])).toBe(2);
    expect(repo.count(true)).toBe(6);
    // 剩下的是另外 6 个
    expect(
      repo.list({ includeArchived: true }).map((c) => c.id).sort(),
    ).toEqual(['c-0', 'c-1', 'c-3', 'c-4', 'c-6', 'c-7']);
  });

  it('treats duplicate ids as a single delete', () => {
    insertRow('only', 1);
    // WHERE id IN (...) 自然去重；sqlite 在 IN 子句里重复元素只命中一次
    expect(repo.deleteMany(['only', 'only', 'only'])).toBe(1);
    expect(repo.count(true)).toBe(0);
  });

  it('handles a batch at the realistic upper bound (200)', () => {
    for (let i = 0; i < 200; i++) insertRow(`c-${i}`, 1000 + i);
    const ids = Array.from({ length: 200 }, (_, i) => `c-${i}`);
    expect(repo.deleteMany(ids)).toBe(200);
    expect(repo.count(true)).toBe(0);
  });
});
