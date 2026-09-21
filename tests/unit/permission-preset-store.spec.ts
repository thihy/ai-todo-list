// 权限预设 —— 会话级的「用户意图」持久层 + 审批闸门的联动。
//
// 背景：DSH 的会话是**首轮才懒创建**的（loadHistory() 不建 agent）。用户在
// 新对话里还没发消息时切预设，DSH 侧根本没有 session 可以承接。所以选择先
// 落 conversations.permission_preset 列（v20 migration），等首轮
// ensureAgent() 建出 live session 时再 pin 进去。
//
// 本测试锁住三件事：
//   1. v20 migration 在存量库上可应用，存量行默认 NULL（= 未选择）
//   2. setPermissionPreset 不 bump updated_at（切预设不是内容变更，
//      不能把会话顶到侧栏顶部）
//   3. 预设值原样 round-trip，包括 null（清除选择）
//
// 审批闸门 decideMutatingToolGate 的行为由 auto-preset-gate.spec.ts 覆盖；
// 这里只管持久层。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { ConversationRepo } from '../../src/main/db/conversation-repo';

describe('权限预设 — 持久层', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: ConversationRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-preset-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new ConversationRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('新建会话的 permissionPreset 是 null（= 用户从未显式选择）', () => {
    const conv = repo.create({ title: '新对话' });
    expect(conv.permissionPreset).toBeNull();
    // get() 走的是另一条 SELECT，也要带出新列
    expect(repo.get(conv.id)?.permissionPreset).toBeNull();
  });

  it('setPermissionPreset 写入后 get / list 都能读到', () => {
    const conv = repo.create({ title: 'A' });
    expect(repo.setPermissionPreset(conv.id, 'read-only')).toBe(true);
    expect(repo.get(conv.id)?.permissionPreset).toBe('read-only');
    expect(repo.list()[0]?.permissionPreset).toBe('read-only');
    // includeArchived 分支是另一条 SQL，单独覆盖
    expect(repo.list({ includeArchived: true })[0]?.permissionPreset).toBe('read-only');
  });

  it('四个预设名原样 round-trip', () => {
    const conv = repo.create({ title: 'A' });
    for (const preset of ['read-only', 'workspace-write', 'auto', 'danger-full-access']) {
      repo.setPermissionPreset(conv.id, preset);
      expect(repo.get(conv.id)?.permissionPreset).toBe(preset);
    }
  });

  it('setPermissionPreset(id, null) 清除选择，回到「未选择」', () => {
    const conv = repo.create({ title: 'A' });
    repo.setPermissionPreset(conv.id, 'danger-full-access');
    expect(repo.setPermissionPreset(conv.id, null)).toBe(true);
    expect(repo.get(conv.id)?.permissionPreset).toBeNull();
  });

  it('切预设不 bump updated_at —— 不能把会话顶到侧栏顶部', () => {
    const a = repo.create({ title: 'A' });
    const b = repo.create({ title: 'B' });
    // 把 A 的时间戳压到 B 之前，模拟「A 是更早的会话」
    handle.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 60_000, a.id);
    const beforeA = repo.get(a.id)!.updatedAt;
    const beforeB = repo.get(b.id)!.updatedAt;

    repo.setPermissionPreset(a.id, 'read-only');

    // 时间戳一动不动
    expect(repo.get(a.id)!.updatedAt).toBe(beforeA);
    expect(repo.get(b.id)!.updatedAt).toBe(beforeB);
    // 排序也没变：B 仍在前面
    expect(repo.list().map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it('未知 id 返回 false，不抛', () => {
    expect(repo.setPermissionPreset('no-such-id', 'auto')).toBe(false);
  });

  it('归档行的预设仍可写（归档 ≠ 冻结配置）', () => {
    const conv = repo.create({ title: 'A' });
    repo.archive(conv.id);
    expect(repo.setPermissionPreset(conv.id, 'workspace-write')).toBe(true);
    expect(repo.get(conv.id)?.permissionPreset).toBe('workspace-write');
  });

  it('delete 后行没了，预设随之消失', () => {
    const conv = repo.create({ title: 'A' });
    repo.setPermissionPreset(conv.id, 'auto');
    repo.delete(conv.id);
    expect(repo.get(conv.id)).toBeUndefined();
  });
});

describe('权限预设 — v20 migration 在存量库上的行为', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-preset-mig-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('openDb 后 conversations 表带 permission_preset 列且可空', () => {
    const handle = openDb(join(dir, 'db.sqlite'));
    try {
      const cols = handle.db
        .prepare('PRAGMA table_info(conversations)')
        .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
      const col = cols.find((c) => c.name === 'permission_preset');
      expect(col).toBeDefined();
      // 可空 + 无默认值 —— 存量行必须是 NULL（= 未选择），
      // 不能悄悄给所有老会话塞一个预设值。
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('重复 openDb 是幂等的（migration 不会重复跑）', () => {
    const path = join(dir, 'db.sqlite');
    const h1 = openDb(path);
    const repo1 = new ConversationRepo(h1.db);
    const conv = repo1.create({ title: 'A' });
    repo1.setPermissionPreset(conv.id, 'read-only');
    h1.close();

    const h2 = openDb(path);
    try {
      const repo2 = new ConversationRepo(h2.db);
      // 值活过了重新打开
      expect(repo2.get(conv.id)?.permissionPreset).toBe('read-only');
    } finally {
      h2.close();
    }
  });
});
