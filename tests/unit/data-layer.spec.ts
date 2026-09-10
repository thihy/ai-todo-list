import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MarkdownStore } from '../../src/main/files/markdown';
import * as paths from '../../src/main/files/paths';

describe('TodoRepo + MarkdownStore', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let md: MarkdownStore;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
    // Mirror production wiring: per-task dir = paths.todoDir(todosDir, repo.get(id).title, id).
    md = new MarkdownStore(handle.db, todosDir, (id) => {
      const t = repo.get(id);
      return paths.todoDir(todosDir, (t?.title as string | undefined) ?? paths.UNTITLED_SLUG, id);
    });
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a TODO and reads it back', () => {
    const t = repo.create({ title: 'Test' }, join(dir, 'todos', 'fake.md'));
    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(t.status).toBe('next');
    expect(t.title).toBe('Test');
  });

  it('updates fields and tags', () => {
    const t = repo.create({ title: 'A' }, 'x');
    const updated = repo.update(t.id, { status: 'doing', priority: 'high', tags: ['x', 'y'] });
    expect(updated.status).toBe('doing');
    expect(updated.priority).toBe('high');
    expect(updated.tags.sort()).toEqual(['x', 'y']);
  });

  it('lists with filter', () => {
    repo.create({ title: 'A', status: 'next' }, 'x');
    repo.create({ title: 'B', status: 'done', priority: 'high' }, 'x');
    const all = repo.list();
    expect(all).toHaveLength(2);
    const pending = repo.list({ status: ['next'] });
    expect(pending).toHaveLength(1);
  });

  it('search uses FTS', () => {
    const a = repo.create({ title: '登录页设计' }, 'x');
    md.writeBody(a.id, '登录流程图与表单状态');
    repo.create({ title: '无关条目' }, 'x');
    const hits = repo.search('登录');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].todo.id).toBe(a.id);
  });

  it('writes markdown body and trims versions to MAX', async () => {
    const t = repo.create({ title: 'MD test' }, 'x');
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = md.writeBody(t.id, `# v${i}`).version;
    }
    const { markdown } = md.readBody(t.id);
    expect(markdown).toContain('v24');
    expect(last).toBeGreaterThanOrEqual(25);
    const hist = md.history(t.id);
    expect(hist.length).toBeLessThanOrEqual(20);
  });

  it('restores a previous version', () => {
    const t = repo.create({ title: 'restore' }, 'x');
    md.writeBody(t.id, 'first');
    md.writeBody(t.id, 'second');
    const hist = md.history(t.id);
    // history orders by saved_at DESC; pick the smallest id (= oldest row)
    // because Date.now() can collide within the same millisecond.
    const oldest = hist.reduce((acc, v) => (v.id < acc.id ? v : acc));
    md.restoreVersion(t.id, oldest.id);
    expect(md.readBody(t.id).markdown.trimEnd()).toBe('first');
  });

  it('auto-archives stale done tasks and excludes them from the default list', () => {
    // A done task finished long ago (well past the threshold).
    const old = repo.create({ title: 'finished last week', status: 'done' }, 'x');
    // Pin done_at into the past so it's "older than 1 day".
    handle.db.prepare('UPDATE todos SET done_at = ? WHERE id = ?').run(Date.now() - 7 * 86_400_000, old.id);
    // A done task finished just now — should stay active.
    const fresh = repo.create({ title: 'finished now', status: 'done' }, 'x');
    // A pending task (default status 未完成) — never archived regardless of age.
    const pending = repo.create({ title: 'still pending' }, 'x');

    // Default list excludes archived (none yet) and shows all three.
    expect(repo.list().map((t) => t.id).sort()).toEqual([fresh.id, pending.id, old.id].sort());

    // Sweep with a 1-day cutoff: only `old` qualifies.
    const cutoff = Date.now() - 1 * 86_400_000;
    expect(repo.archiveStale(cutoff)).toBe(1);

    // `old` is now archived; default list hides it.
    expect(repo.list().map((t) => t.id).sort()).toEqual([fresh.id, pending.id].sort());
    // archivedOnly surfaces it; archivedAt is stamped.
    const bin = repo.list({ archivedOnly: true });
    expect(bin).toHaveLength(1);
    expect(bin[0].id).toBe(old.id);
    expect(bin[0].archivedAt).not.toBeNull();
    // includeArchived returns everything.
    expect(repo.list({ includeArchived: true })).toHaveLength(3);

    // Idempotent: re-running the sweep archives nothing new.
    expect(repo.archiveStale(cutoff)).toBe(0);

    // Restore via update({ archivedAt: null }) returns it to the active list.
    repo.update(old.id, { archivedAt: null });
    expect(repo.list().map((t) => t.id)).toContain(old.id);
    expect(repo.list({ archivedOnly: true })).toHaveLength(0);
  });

  it('soft-deletes a task (and its subtree) and restores it', () => {
    // A parent with two subtasks; the second subtask has its own child to
    // verify the cascade goes >1 level deep.
    const parent = repo.create({ title: 'parent' }, 'x');
    const child1 = repo.create({ title: 'child1', parentId: parent.id }, 'x');
    const child2 = repo.create({ title: 'child2', parentId: parent.id }, 'x');
    const grand = repo.create({ title: 'grand', parentId: child2.id }, 'x');
    // An unrelated task that must NOT be touched.
    const other = repo.create({ title: 'unrelated' }, 'x');

    // Default list shows all five (none deleted).
    expect(repo.list().map((t) => t.id).sort()).toEqual(
      [parent.id, child1.id, child2.id, grand.id, other.id].sort(),
    );

    // Soft-delete the parent — the whole subtree (child1, child2, grand)
    // cascades to deleted_at; `other` is untouched.
    repo.delete(parent.id);

    // Active list now only has `other`.
    expect(repo.list().map((t) => t.id)).toEqual([other.id]);

    // deletedOnly surfaces the subtree, newest-deletion-first is irrelevant
    // here (all stamped in the same UPDATE). Every deleted row carries
    // deletedAt.
    const bin = repo.list({ deletedOnly: true });
    expect(bin.map((t) => t.id).sort()).toEqual(
      [parent.id, child1.id, child2.id, grand.id].sort(),
    );
    for (const t of bin) expect(t.deletedAt).not.toBeNull();
    // `other` is NOT in the bin.
    expect(bin.find((t) => t.id === other.id)).toBeUndefined();

    // Restoring the parent clears deleted_at on the WHOLE subtree.
    repo.restore(parent.id);
    const back = repo.list();
    expect(back.map((t) => t.id).sort()).toEqual(
      [parent.id, child1.id, child2.id, grand.id, other.id].sort(),
    );
    for (const t of back) expect(t.deletedAt).toBeNull();
    expect(repo.list({ deletedOnly: true })).toHaveLength(0);
  });

  it('excludes soft-deleted tasks from search and stats', () => {
    const keep = repo.create({ title: 'keepme searchable', status: 'done' }, 'x');
    const gone = repo.create({ title: 'goneme searchable', status: 'done' }, 'x');
    repo.delete(gone.id);

    // Search for the shared substring — only the live task hits.
    const hits = repo.search('searchable');
    expect(hits.map((h) => h.todo.id)).toEqual([keep.id]);

    // Stats count only live tasks: total=1, done=1.
    const s = repo.stats();
    expect(s.total).toBe(1);
    expect(s.byStatus.done).toBe(1);
  });

  describe('progress log burst-merge', () => {
    it('collapses rapid no-note writes within 60s into a single row', () => {
      const t = repo.create({ title: 'Merge me' }, join(dir, 'todos', 'm.md'));
      repo.logProgress(t.id, 10);
      repo.logProgress(t.id, 25);
      const last = repo.logProgress(t.id, 40);
      const rows = repo.listProgress(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(last.entry.id);
      expect(rows[0].percent).toBe(40);
      expect(rows[0].note).toBeNull();
    });

    it('does not merge across a real note (note ends the burst)', () => {
      // Date.now() can return the same ms across rapid calls — that would
      // collapse rows whose order is then arbitrary. Force monotonic
      // timestamps here so the merge logic sees a real ordering.
      const t = repo.create({ title: 'Noted' }, join(dir, 'todos', 'n.md'));
      const base = Date.now();
      const realNow = Date.now;
      let cursor = base;
      Date.now = (): number => {
        cursor += 100; // 100ms apart, all within the 60s window
        return cursor;
      };
      try {
        repo.logProgress(t.id, 10);                       // burst 1: no note
        repo.logProgress(t.id, 25, 'completed first step'); // new row: with note
        repo.logProgress(t.id, 35);                       // null note, INSERT
      } finally {
        Date.now = realNow;
      }
      const rows = repo.listProgress(t.id);
      // Three rows: collapsed burst-1 (10), the noted row (25), the
      // subsequent no-note row (35 — its own burst).
      expect(rows).toHaveLength(3);
      const noted = rows.find((r) => r.note !== null);
      expect(noted?.percent).toBe(25);
      expect(noted?.note).toBe('completed first step');
      const noNotes = rows.filter((r) => r.note === null).map((r) => r.percent).sort((a, b) => a - b);
      expect(noNotes).toEqual([10, 35]);
    });

    it('update({progress}) path also burst-merges', () => {
      const t = repo.create({ title: 'Update path' }, join(dir, 'todos', 'u.md'));
      repo.update(t.id, { progress: 10 });
      repo.update(t.id, { progress: 25 });
      repo.update(t.id, { progress: 40 });
      const rows = repo.listProgress(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].percent).toBe(40);
    });
  });
});