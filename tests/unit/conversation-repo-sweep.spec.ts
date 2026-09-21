// ConversationRepo.sweep — 容量上限自动清理。
//
// 行为契约：
//   - maxCount <= 0 → 表示不限，直接返回 []
//   - 当前未归档数 <= maxCount → 返回 []（不需要清理）
//   - 当前未归档数 > maxCount → 删 (current - maxCount) 条，按 updated_at ASC 取最老
//   - 只动 archived = 0 的行；归档里的对话永远不被 sweep
//   - 归档 + 未归档混合时，删的是未归档里 updated_at 最小的，归档全保留
//   - 返回值改为 `string[]`：被清掉的 conversation id 列表，让 caller 可以
//     顺手清掉对应的 AI composer inbox 文件（见 src/main/ipc/ai-handlers.ts
//     ai.conversation.create 的 sweep 分支）。改返回值的另一个动机是
//     「删了几条」这种数量信息对 UI 没用 —— caller 想知道的本来就是
//     「具体哪些 id 没了」。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { ConversationRepo } from '../../src/main/db/conversation-repo';

describe('ConversationRepo — sweep', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: ConversationRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-conv-sweep-'));
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

  it('returns [] when maxCount is 0 (unlimited)', () => {
    for (let i = 0; i < 30; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(0)).toEqual([]);
    expect(repo.count(true)).toBe(30);
  });

  it('returns [] when maxCount is negative (treated as unlimited)', () => {
    for (let i = 0; i < 10; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(-5)).toEqual([]);
    expect(repo.count(true)).toBe(10);
  });

  it('returns [] when current count is below the cap', () => {
    for (let i = 0; i < 5; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(10)).toEqual([]);
    expect(repo.count(true)).toBe(5);
  });

  it('returns [] when current count equals the cap', () => {
    for (let i = 0; i < 10; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(10)).toEqual([]);
    expect(repo.count(true)).toBe(10);
  });

  it('removes exactly 1 row when current = cap + 1, choosing the oldest', () => {
    // 11 条，cap = 10，应该删 1 条 = updated_at 最小的那条（c-0）
    for (let i = 0; i < 11; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(10)).toEqual(['c-0']);
    expect(repo.count(true)).toBe(10);
    // c-0 应该被清掉
    const remaining = repo.list({ includeArchived: true }).map((c) => c.id);
    expect(remaining).not.toContain('c-0');
    expect(remaining).toHaveLength(10);
  });

  it('removes the (current - cap) oldest rows when overflowing', () => {
    // 15 条，cap = 10，应该删 5 条 = updated_at 最小的前 5 条 (c-0..c-4)
    for (let i = 0; i < 15; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(10)).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4']);
    expect(repo.count(true)).toBe(10);
    const remaining = repo.list({ includeArchived: true }).map((c) => c.id);
    expect(remaining).not.toContain('c-0');
    expect(remaining).not.toContain('c-1');
    expect(remaining).not.toContain('c-2');
    expect(remaining).not.toContain('c-3');
    expect(remaining).not.toContain('c-4');
    // c-5 起保留
    expect(remaining.sort()).toEqual([
      'c-10',
      'c-11',
      'c-12',
      'c-13',
      'c-14',
      'c-5',
      'c-6',
      'c-7',
      'c-8',
      'c-9',
    ]);
  });

  it('never touches archived rows even if they are the oldest', () => {
    // 5 条未归档 + 5 条归档（全部比未归档更老），cap = 5。
    // sweep 只看未归档的 count，所以 current(未归档) = 5 <= cap，不删任何东西。
    const ts = 100;
    for (let i = 0; i < 5; i++) insertRow(`live-${i}`, ts + 100 + i, 0);
    for (let i = 0; i < 5; i++) insertRow(`arch-${i}`, ts + i, 1); // 更老，但归档
    expect(repo.sweep(5)).toEqual([]);
    expect(repo.count(true)).toBe(10); // 总数不变
  });

  it('with mixed archived + live, sweeps only live rows', () => {
    // 8 条未归档 + 4 条归档（共 12）。cap = 5 → 未归档要删 3 条。
    // 删的是未归档里 updated_at 最小的 3 条；归档 4 条全保留。
    const ts = 1000;
    for (let i = 0; i < 8; i++) insertRow(`live-${i}`, ts + 100 + i, 0); // 1100..1107
    for (let i = 0; i < 4; i++) insertRow(`arch-${i}`, ts + i, 1); // 1000..1003
    expect(repo.sweep(5)).toEqual(['live-0', 'live-1', 'live-2']);
    expect(repo.count(true)).toBe(9);
    // 归档的全在
    const all = repo.list({ includeArchived: true }).map((c) => c.id).sort();
    for (const a of ['arch-0', 'arch-1', 'arch-2', 'arch-3']) {
      expect(all).toContain(a);
    }
    // 被清的是 live-0, live-1, live-2（未归档里最老的 3 个）
    expect(all).not.toContain('live-0');
    expect(all).not.toContain('live-1');
    expect(all).not.toContain('live-2');
  });

  it('is a no-op on an empty table', () => {
    expect(repo.sweep(10)).toEqual([]);
    expect(repo.count(true)).toBe(0);
  });

  it('removing all live rows when none are archived but cap is 0', () => {
    // cap = 0 应该表示「不限」—— 与 sweep 的 maxCount <= 0 分支一致。
    for (let i = 0; i < 5; i++) insertRow(`c-${i}`, 100 + i);
    expect(repo.sweep(0)).toEqual([]);
    expect(repo.count(true)).toBe(5);
  });
});
