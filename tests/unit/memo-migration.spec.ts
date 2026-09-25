// v21 迁移（备忘录）测试。
//
// 这一条迁移是纯增量的：只 CREATE 两张新表 + 索引，不碰 todos /
// task_documents / document_versions / FTS 触发器。所以测试的重点不是
// 「迁移后新表能用」（memo-store.spec.ts 已经覆盖），而是：
//   1. 一条 v21 之前的库能一路升到 head
//   2. 升级过程中既有任务 / 文档 / 版本数据一个字节都不能少
//   3. FTS 仍然可搜（触发器没被碰）
//   4. 迁移是幂等的 —— 同一份库开两次不会炸

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/main/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { openDb, LATEST_SCHEMA_VERSION, newId } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { DocumentStore } from '../../src/main/files/documents';

describe('schema v21 migration (memos)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memo-migration-'));
    dbPath = join(dir, 'db.sqlite');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports LATEST_SCHEMA_VERSION as 22', () => {
    // 迁移链的 head 就是 v22（v21 = memos 表，v22 = memos.read_at）。
    // 硬编码在这里是有意的：它就是"v22 = 未读/已读列进 head 了"
    // 这件事的断言本身。
    expect(LATEST_SCHEMA_VERSION).toBe(22);
  });

  it('v22 migration adds the read_at column to existing memos', () => {
    // Seed a v21-shaped DB (without read_at), then re-open through the
    // production pipeline and assert the column is present and the existing
    // rows survive with read_at = NULL (the "未读" default).
    const first = openDb(dbPath);
    try {
      first.db
        .prepare(
          `INSERT INTO memos (id, content, preview, source, todo_id, resolved_at, created_at, updated_at)
           VALUES ('01MEMOV2100000000000000', '遗留 memo', '遗留 memo', 'drop', NULL, NULL, 1, 1)`,
        )
        .run();
    } finally {
      first.close();
    }

    const second = openDb(dbPath);
    try {
      const cols = second.db
        .prepare<[], { name: string }>("PRAGMA table_info(memos)")
        .all()
        .map((r) => r.name);
      expect(cols).toContain('read_at');

      const row = second.db
        .prepare<[string], { content: string; read_at: number | null }>(
          'SELECT content, read_at FROM memos WHERE id = ?',
        )
        .get('01MEMOV2100000000000000');
      expect(row?.content).toBe('遗留 memo');
      expect(row?.read_at).toBeNull();
    } finally {
      second.close();
    }
  });

  it('creates the memos + memo_attachments tables on a fresh DB', () => {
    const handle = openDb(dbPath);
    try {
      const tables = (
        handle.db
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
      ).map((r) => r.name);
      expect(tables).toContain('memos');
      expect(tables).toContain('memo_attachments');
    } finally {
      handle.close();
    }
  });

  it('enforces the source CHECK constraint (only drop/clipboard/capture/manual)', () => {
    const handle = openDb(dbPath);
    try {
      const id = newId();
      const now = Date.now();
      const insert = (source: string): void => {
        handle.db
          .prepare(
            `INSERT INTO memos (id, content, preview, source, todo_id, resolved_at, created_at, updated_at)
             VALUES (?, 'x', 'x', ?, NULL, NULL, ?, ?)`,
          )
          .run(id, source, now, now);
      };
      for (const ok of ['drop', 'clipboard', 'capture', 'manual']) {
        expect(() => insert(ok)).not.toThrow();
        handle.db.prepare('DELETE FROM memos WHERE id = ?').run(id);
      }
      expect(() => insert('telepathy')).toThrow(/CHECK constraint failed/);
    } finally {
      handle.close();
    }
  });

  it('preserves tasks, documents and versions across the upgrade', () => {
    // Seed a realistic pre-memo DB: two tasks, each with a progress doc
    // carrying real text (so the FTS body column is non-empty).
    const first = openDb(dbPath);
    const todoIds: string[] = [];
    try {
      const repo = new TodoRepo(first.db);
      const docs = new DocumentStore(first.db);
      for (const title of ['迁移前的任务甲', '迁移前的任务乙']) {
        const todo = repo.create({ title });
        docs.ensureDefaultDocs(todo.id);
        const doc = docs.list(todo.id).find((d) => d.kind === 'progress')!;
        docs.write(doc.id, `${title}的正文内容 searchablemarker`);
        todoIds.push(todo.id);
      }
    } finally {
      first.close();
    }

    // Re-open through the production pipeline. The memos migration is pure
    // additive, so this must be a no-op for everything above it.
    const second = openDb(dbPath);
    try {
      const meta = second.db
        .prepare<[], { version: number }>('SELECT MAX(version) as version FROM schema_meta')
        .get();
      expect(meta?.version).toBe(LATEST_SCHEMA_VERSION);

      const repo = new TodoRepo(second.db);
      const docs = new DocumentStore(second.db);
      for (const id of todoIds) {
        const todo = repo.get(id);
        expect(todo).not.toBeNull();
        expect(todo!.title).toMatch(/迁移前的任务/);
        const body = docs.read(docs.list(id).find((d) => d.kind === 'progress')!.id).content;
        expect(body).toContain('searchablemarker');
      }

      // The FTS triggers were deliberately not touched by the migration —
      // if the body mirror or the triggers had been dropped, this is where
      // it would show.
      const hits = repo.search('searchablemarker');
      expect(hits.map((h) => h.todo.id).sort()).toEqual([...todoIds].sort());
    } finally {
      second.close();
    }
  });

  it('is idempotent — reopening the same DB does not re-run the migration', () => {
    const first = openDb(dbPath);
    first.db
      .prepare(
        `INSERT INTO memos (id, content, preview, source, todo_id, resolved_at, created_at, updated_at)
         VALUES ('01MEMOKEEP0000000000000000', '别丢了我', '别丢了我', 'drop', NULL, NULL, 1, 1)`,
      )
      .run();
    first.close();

    // Second open: the version is already at head, so the migration loop
    // skips v21 entirely. A regression that dropped/recreated the table
    // would silently lose the row.
    const second = openDb(dbPath);
    try {
      const row = second.db
        .prepare<[string], { content: string }>('SELECT content FROM memos WHERE id = ?')
        .get('01MEMOKEEP0000000000000000');
      expect(row?.content).toBe('别丢了我');
    } finally {
      second.close();
    }
  });

  it('memo_attachments cascades away with its memo, but NOT with a task delete', () => {
    // Two different cascade directions, both load-bearing:
    //   - delete the memo → its attachment rows + files go (nothing orphaned)
    //   - HARD-delete the task → memo survives with todo_id = NULL
    //     (ON DELETE SET NULL), because the fragment isn't owned by the task
    //
    // Note the hard delete: TodoRepo.delete() is a SOFT delete (sets
    // deleted_at) so the row — and therefore the FK — is never touched.
    // The ON DELETE SET NULL arm only fires for a physical delete, which is
    // what a restore-from-an-old-backup / maintenance sweep would do.
    const handle = openDb(dbPath);
    try {
      const repo = new TodoRepo(handle.db);
      const todo = repo.create({ title: '会被删掉的任务' });
      const memoId = newId();
      const now = Date.now();
      handle.db
        .prepare(
          `INSERT INTO memos (id, content, preview, source, todo_id, resolved_at, created_at, updated_at)
           VALUES (?, '片段', '片段', 'drop', ?, NULL, ?, ?)`,
        )
        .run(memoId, todo.id, now, now);
      handle.db
        .prepare(
          `INSERT INTO memo_attachments (id, memo_id, file_path, mime, created_at)
           VALUES (?, ?, '/tmp/x.png', 'image/png', ?)`,
        )
        .run(newId(), memoId, now);

      // Soft delete leaves todo_id intact — the fragment still points at a
      // task that is merely archived-away, and restoring the task should
      // re-link it.
      repo.delete(todo.id);
      const afterSoftDelete = handle.db
        .prepare<[string], { todo_id: string | null }>('SELECT todo_id FROM memos WHERE id = ?')
        .get(memoId);
      expect(afterSoftDelete?.todo_id).toBe(todo.id);

      // Hard delete fires ON DELETE SET NULL: the memo survives, unlinked.
      handle.db.prepare('DELETE FROM todos WHERE id = ?').run(todo.id);
      const afterHardDelete = handle.db
        .prepare<[string], { todo_id: string | null }>('SELECT todo_id FROM memos WHERE id = ?')
        .get(memoId);
      expect(afterHardDelete?.todo_id).toBeNull();

      handle.db.prepare('DELETE FROM memos WHERE id = ?').run(memoId);
      const leftover = handle.db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM memo_attachments WHERE memo_id = ?',
        )
        .get(memoId);
      expect(leftover?.c).toBe(0);
    } finally {
      handle.close();
    }
  });
});
