// ConversationRepo — sidebar 分页 + 窗口上限。
//
// 行为契约：
//   - list() 不带参 → 默认 10 条（DEFAULT_CONVERSATION_LIST_LIMIT）
//   - list({ limit: N }) → 取 N 条；超过 MAX_CONVERSATION_LIST_LIMIT 时夹紧
//   - list({ offset: N }) → 从第 N+1 条开始
//   - list({ includeArchived: true }) → 含归档
//   - count() 与 list() 在同一过滤条件下结果一致
//   - 已加载条数永远不会随库内行数线性增长 —— 渲染端按需翻页

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import {
  ConversationRepo,
  DEFAULT_CONVERSATION_LIST_LIMIT,
  MAX_CONVERSATION_LIST_LIMIT,
} from '../../src/main/db/conversation-repo';

describe('ConversationRepo — pagination', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: ConversationRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-conv-page-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new ConversationRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the default page size when no limit is given', () => {
    // 造 25 条，按 repo.create 默认同毫秒内 updated_at 撞值会让 ORDER BY
    // 不确定。直接 INSERT + 显式 updated_at 才能稳定断言。
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
    );
    const baseTs = Date.now() - 1000;
    for (let i = 0; i < 25; i++) {
      const ts = baseTs + i;
      insert.run(`c-${i}`, `c-${i}`, ts, ts);
    }
    const listed = repo.list();
    expect(listed).toHaveLength(DEFAULT_CONVERSATION_LIST_LIMIT);
    expect(DEFAULT_CONVERSATION_LIST_LIMIT).toBe(10);
  });

  it('honours an explicit limit', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
    );
    const baseTs = Date.now() - 1000;
    for (let i = 0; i < 30; i++) {
      const ts = baseTs + i;
      insert.run(`c-${i}`, `c-${i}`, ts, ts);
    }
    expect(repo.list({ limit: 5 })).toHaveLength(5);
    expect(repo.list({ limit: 20 })).toHaveLength(20);
  });

  it('clamps an oversized limit to MAX_CONVERSATION_LIST_LIMIT', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
    );
    const baseTs = Date.now() - 1000;
    for (let i = 0; i < 80; i++) {
      const ts = baseTs + i;
      insert.run(`c-${i}`, `c-${i}`, ts, ts);
    }
    // 渲染端可能误传 999；repo 必须夹到 50。
    expect(repo.list({ limit: 999 })).toHaveLength(MAX_CONVERSATION_LIST_LIMIT);
    expect(MAX_CONVERSATION_LIST_LIMIT).toBe(50);
    // 0/负数/NaN 回退到默认值
    expect(repo.list({ limit: 0 })).toHaveLength(DEFAULT_CONVERSATION_LIST_LIMIT);
    expect(repo.list({ limit: -5 })).toHaveLength(DEFAULT_CONVERSATION_LIST_LIMIT);
    expect(repo.list({ limit: NaN })).toHaveLength(DEFAULT_CONVERSATION_LIST_LIMIT);
  });

  it('walks forward by offset, returning subsequent pages', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
    );
    const baseTs = Date.now() - 1000;
    for (let i = 0; i < 25; i++) {
      const ts = baseTs + i;
      insert.run(`c-${i}`, `c-${i}`, ts, ts);
    }
    // updated_at DESC → 最新的是 c-24（最大 ts）；offset 10 应跳过前 10 条
    const page1 = repo.list({ limit: 10, offset: 0 });
    const page2 = repo.list({ limit: 10, offset: 10 });
    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    // 不重叠
    const ids1 = new Set(page1.map((c) => c.id));
    expect(ids1.size).toBe(10);
    for (const c of page2) expect(ids1.has(c.id)).toBe(false);
    // 排序保持：page1 第一条 updatedAt > page2 最后一条 updatedAt
    expect(page1[0]!.updatedAt).toBeGreaterThan(page2[page2.length - 1]!.updatedAt);
  });

  it('clamps a negative or fractional offset to 0', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
    );
    const ts = Date.now();
    insert.run('only', 'only', ts, ts);
    expect(repo.list({ offset: -1 })).toHaveLength(1);
    expect(repo.list({ offset: NaN })).toHaveLength(1);
  });

  it('exposes count() that matches the same filter as list()', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?)',
    );
    const ts = Date.now() - 1000;
    for (let i = 0; i < 12; i++) insert.run(`c-${i}`, `c-${i}`, ts + i, ts + i, 0);
    for (let i = 0; i < 4; i++) insert.run(`a-${i}`, `a-${i}`, ts + 100 + i, ts + 100 + i, 1);
    expect(repo.count()).toBe(12);
    expect(repo.count(true)).toBe(16);
    expect(repo.list()).toHaveLength(10);
    expect(repo.list({ limit: 100 })).toHaveLength(12);
  });

  it('hides archived rows from the default list', () => {
    const insert = handle.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?)',
    );
    const ts = Date.now() - 1000;
    insert.run('live', 'live', ts, ts, 0);
    insert.run('dead', 'dead', ts + 1, ts + 1, 1);
    const list = repo.list();
    expect(list.map((c) => c.id)).toEqual(['live']);
    const all = repo.list({ includeArchived: true });
    expect(all.map((c) => c.id).sort()).toEqual(['dead', 'live']);
  });

  it('locks the limit constants so silent drift breaks the build', () => {
    // 显式把契约钉在测试里 —— 有人随手改成 5 或 20，会立刻红。
    expect(DEFAULT_CONVERSATION_LIST_LIMIT).toBe(10);
    expect(MAX_CONVERSATION_LIST_LIMIT).toBe(50);
  });
});