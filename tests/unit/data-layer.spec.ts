import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MarkdownStore } from '../../src/main/files/markdown';
import * as paths from '../../src/main/files/paths';
import { writeTodoJson } from '../../src/main/files/rename-hooks';

// better-sqlite3 default export is the constructor function. Used directly
// by the v12→v13 migration test to lay down a v12-shaped DB without going
// through openDb's migration runner.
const DatabaseImport = Database;

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

  describe('planned_for (今日待办 stamp)', () => {
    // planned_for is a local-date 'YYYY-MM-DD' string (not ms) — tz-stable
    // and human-grokkable. Tests below use a fixed reference date so they
    // don't depend on the wall clock at test time.
    const todayKey = (() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    it('defaults to null on create and is reflected through list/get', () => {
      const t = repo.create({ title: 'plain' }, 'x');
      expect(t.plannedFor).toBeNull();
      expect(repo.get(t.id)?.plannedFor).toBeNull();
      expect(repo.list().every((x) => x.plannedFor === null)).toBe(true);
    });

    it('accepts an initial plannedFor at create time', () => {
      const t = repo.create({ title: 'planned at birth', plannedFor: todayKey }, 'x');
      expect(t.plannedFor).toBe(todayKey);
    });

    it('update({plannedFor}) sets and clears the stamp', () => {
      const t = repo.create({ title: 'stamped' }, 'x');
      const planned = repo.update(t.id, { plannedFor: todayKey });
      expect(planned.plannedFor).toBe(todayKey);
      // Re-read via get() — the column is persisted, not just mutated in memory.
      expect(repo.get(t.id)?.plannedFor).toBe(todayKey);

      // Clearing with explicit null returns it to the un-planned state.
      const cleared = repo.update(t.id, { plannedFor: null });
      expect(cleared.plannedFor).toBeNull();
      expect(repo.get(t.id)?.plannedFor).toBeNull();
    });

    it('countPlannedFor(todayKey) returns only matching active rows', () => {
      const a = repo.create({ title: 'planned A', plannedFor: todayKey }, 'x');
      repo.create({ title: 'unplanned B' }, 'x');
      const c = repo.create({ title: 'planned C', plannedFor: todayKey }, 'x');
      // Use the repo's actual delete + archive flows (not raw column updates)
      // — same paths production code goes through.
      repo.delete(c.id);                          // soft-deleted → excluded
      const d = repo.create({ title: 'planned D', plannedFor: todayKey }, 'x');
      repo.update(d.id, { archivedAt: Date.now() }); // archived → excluded
      repo.delete(a.id);                          // soft-deleted → excluded
      expect(repo.countPlannedFor(todayKey)).toBe(0);
      // Add one more live planned-for-today row to confirm the count tracks
      // only the live (non-deleted, non-archived) set.
      const e = repo.create({ title: 'planned E', plannedFor: todayKey }, 'x');
      expect(repo.countPlannedFor(todayKey)).toBe(1);
      expect(e.plannedFor).toBe(todayKey);
    });

    it('update({plannedFor}) also writes the per-task todo.json snapshot', () => {
      // Mirror the production call site — IPC handlers always go through
      // the repo + writeTodoJson pair, so the JSON mirror has to include the
      // new stamp.
      const t = repo.create({ title: 'snapshot me', plannedFor: todayKey }, 'x');
      const taskDir = join(todosDir, t.id);
      const fresh = repo.get(t.id)!;
      writeTodoJson(taskDir, {
        id: fresh.id,
        title: fresh.title,
        status: fresh.status,
        priority: fresh.priority,
        tags: fresh.tags,
        dueAt: fresh.dueAt,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
        doneAt: fresh.doneAt,
        plannedFor: fresh.plannedFor,
      });
      const json = JSON.parse(readFileSync(join(taskDir, 'todo.json'), 'utf8'));
      expect(json.plannedFor).toBe(todayKey);
    });
  });

  it('migrates v13 → v14 by converting planned_for from INTEGER to TEXT', () => {
    // Lay down a v13-shaped DB in its OWN tempdir (so we don't fight the
    // outer rmSync in afterEach for an SQLite file we want to keep around
    // long enough for openDb to reopen). Then close the outer handle, swap
    // the outer handle+repo to point at the v13 DB, and let the production
    // migration pipeline run v14 — the v13 → v14 conversion should turn
    // each non-null INTEGER planned_for into the local-date 'YYYY-MM-DD'.
    //
    // We seed TWO rows:
    //   - row A with planned_for set to today's local-midnight ms (the
    //     common case from real v13 production data).
    //   - row B with planned_for NULL (must stay NULL after migration).
    // Both must survive the column rebuild.
    const v13Dir = mkdtempSync(join(tmpdir(), 'todo-list-v13-'));
    const v13DbPath = join(v13Dir, 'db.sqlite');
    const v13Handle = new DatabaseImport(v13DbPath);
    v13Handle.pragma('foreign_keys = OFF');
    v13Handle.exec(`
      CREATE TABLE schema_meta (version INTEGER PRIMARY KEY);
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('next','doing','blocked','done','cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('none','low','medium','high')),
        project TEXT,
        due_at INTEGER,
        body_path TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        parent_id TEXT,
        archived_at INTEGER,
        deleted_at INTEGER,
        progress INTEGER NOT NULL DEFAULT 0,
        planned_for INTEGER,
        FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_todos_planned_for ON todos(planned_for);
      CREATE TABLE tags (todo_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(todo_id, tag));
      CREATE TABLE progress_log (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, percent INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE task_documents (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, ref_id TEXT, url TEXT, ord INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, description TEXT);
      CREATE TABLE drawings (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, title TEXT, path TEXT NOT NULL, thumb_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE inbox_attachments (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, file_path TEXT NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE ai_memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, source_invocation_id TEXT);
      CREATE TABLE ai_cost_log (id INTEGER PRIMARY KEY AUTOINCREMENT, invocation_id TEXT NOT NULL, skill_id TEXT NOT NULL, model TEXT NOT NULL, duration_ms INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE document_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, content TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE content_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE link_index (from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(from_id, to_id, kind));
      CREATE VIRTUAL TABLE todos_fts USING fts5(title, body, content='todos', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
      CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body); END;
      CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body); INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
      INSERT INTO schema_meta(version) VALUES (13);
    `);
    // Row A: planned_for stamped with today's local-midnight ms. We compute
    // the same value the v13 code path did: setHours(0,0,0,0) in local tz.
    const stampMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    v13Handle
      .prepare(
        'INSERT INTO todos (id, title, status, priority, body_path, created_at, updated_at, planned_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('01ABCDEFGHJKMNPQRSTVWXYZAA', 'planned task', 'next', 'none', 'a.md', 1, 1, stampMs);
    // Row B: null planned_for — must stay null after migration.
    v13Handle
      .prepare(
        'INSERT INTO todos (id, title, status, priority, body_path, created_at, updated_at, planned_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('01ABCDEFGHJKMNPQRSTVWXYZBB', 'unplanned task', 'next', 'none', 'b.md', 1, 1, null);
    v13Handle.close();

    // Re-open via the production migration pipeline; v14 should run cleanly.
    const migrated = openDb(v13DbPath);
    try {
      const meta = migrated.db
        .prepare<[], { version: number }>('SELECT MAX(version) as version FROM schema_meta')
        .get();
      expect(meta?.version).toBe(16);

      const repo14 = new TodoRepo(migrated.db);
      const all = repo14.list();
      expect(all).toHaveLength(2);

      const a = all.find((t) => t.id === '01ABCDEFGHJKMNPQRSTVWXYZAA')!;
      const b = all.find((t) => t.id === '01ABCDEFGHJKMNPQRSTVWXYZBB')!;

      // A's stamp is now the local-date string for today.
      const pad = (n: number) => String(n).padStart(2, '0');
      const todayKey = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;
      expect(typeof a.plannedFor).toBe('string');
      expect(a.plannedFor).toBe(todayKey);

      // B's stamp stayed null.
      expect(b.plannedFor).toBeNull();

      // The index is still on planned_for (recreated by the migration).
      const idxRows = migrated.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_todos_planned_for'",
        )
        .all();
      expect(idxRows).toHaveLength(1);
    } finally {
      migrated.close();
      rmSync(v13Dir, { recursive: true, force: true });
    }
  });

  it('migrations never issue synchronous FTS5 full-table rebuilds', () => {
    // `INSERT INTO todos_fts(todos_fts) VALUES('rebuild')` tokenizes every
    // row's title+body on the main thread during boot, before any window
    // paints. On databases with hundreds of todos + bodies, that turns into
    // a multi-second "未响应" hang right after launch. The v8 migration
    // shipped with one because v8 rebuilt the content table; v14 and any
    // future migrations that don't touch title/body must NOT include it.
    //
    // Read the migration source and assert no migration script issues the
    // rebuild command. This is a static check — catches a regression at
    // test time before users hit it at boot time.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const schemaSrc = readFileSync(
      new URL('../../src/main/db/schema.ts', import.meta.url),
      'utf8',
    );
    // Walk each migration's SQL block. Migrations are `{ version, sql }`
    // literals; isolate each block by version number.
    const migrations = [...schemaSrc.matchAll(/version:\s*(\d+),[\s\S]*?sql:\s*`([\s\S]*?)`/g)];
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) {
      const version = Number(m[1]);
      const sql = m[2];
      const hasRebuild = /INSERT\s+INTO\s+todos_fts\s*\(\s*todos_fts\s*\)\s*VALUES\s*\(\s*'rebuild'\s*\)/i.test(sql);
      // v8 is the only exception: it had to rebuild because it rebuilt the
      // content table. All later migrations leave title/body untouched, so
      // they must not include the rebuild.
      if (version === 8) {
        expect(hasRebuild, `v8 should still include FTS rebuild`).toBe(true);
      } else {
        expect(
          hasRebuild,
          `migration v${version} must NOT include 'INSERT INTO todos_fts VALUES(''rebuild'')' — ` +
            `it tokenizes every row synchronously on first boot and hangs the window`,
        ).toBe(false);
      }
    }
  });
});
