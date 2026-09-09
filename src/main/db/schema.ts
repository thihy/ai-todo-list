// SQLite schema + migrations. Sole authority for runtime state.
// Files (Markdown, Excalidraw JSON) are projected FROM this DB; DB is the truth.

import Database from 'better-sqlite3';
import ulidPkg from 'ulid';
const { ulid } = ulidPkg;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 8;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_meta (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('inbox','next','doing','blocked','done')),
        priority TEXT NOT NULL CHECK (priority IN ('none','low','medium','high')),
        project TEXT,
        due_at INTEGER,
        body_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER
      );
      CREATE INDEX idx_todos_status ON todos(status);
      CREATE INDEX idx_todos_due_at ON todos(due_at);
      CREATE INDEX idx_todos_project ON todos(project);
      CREATE INDEX idx_todos_updated_at ON todos(updated_at DESC);

      CREATE TABLE tags (
        todo_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY(todo_id, tag),
        FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_tags_tag ON tags(tag);

      CREATE TABLE drawings (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        title TEXT,
        path TEXT NOT NULL,
        thumb_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_drawings_todo ON drawings(todo_id);

      CREATE TABLE content_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        todo_id TEXT NOT NULL,
        body TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_versions_todo ON content_versions(todo_id, saved_at DESC);

      CREATE TABLE link_index (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('body','drawing')),
        PRIMARY KEY(from_id, to_id, kind)
      );
      CREATE INDEX idx_link_to ON link_index(to_id);

      CREATE TABLE inbox_attachments (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_attach_todo ON inbox_attachments(todo_id);

      CREATE TABLE ai_memory (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('preference','fact','context')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source_invocation_id TEXT
      );
      CREATE INDEX idx_memory_created ON ai_memory(created_at DESC);

      CREATE TABLE ai_cost_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        model TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_cost_created ON ai_cost_log(created_at DESC);

      CREATE VIRTUAL TABLE todos_fts USING fts5(
        title,
        body,
        content='todos',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
        INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, '');
      END;
      CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, '');
      END;
      CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, '');
        INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, '');
      END;

      CREATE TRIGGER trg_touch_updated_at AFTER UPDATE ON todos
      BEGIN
        UPDATE todos SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
      END;
    `,
  },
  {
    version: 2,
    // Groups are a hand-edited directory TREE — distinct from the `project`
    // field / tags. Tasks (todos) are "files" filed under a group. A task's
    // group_id may be null (= unfiled / root). Deleting a group un-files its
    // tasks rather than deleting them, and cascades to child groups.
    sql: `
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_groups_parent ON groups(parent_id);

      ALTER TABLE todos ADD COLUMN group_id TEXT;
      CREATE INDEX idx_todos_group ON todos(group_id);
    `,
  },
  {
    version: 3,
    // Conversations are independent AI threads the user controls (new /
    // rename / delete / switch). Each conversation maps 1:1 to a DSH session
    // persisted as <DSH_SESSIONS_ROOT>/<sanitized-cwd>/<id>/session.jsonl.zstd.
    // The DB row holds only user-visible metadata (title, timestamps); the
    // event log lives in the JSONL backend so the AI sees its prior turns.
    //
    // archived is a soft-delete flag so the user can recover deleted threads.
    // Hard delete (DROP) would also remove the JSONL file on the persistence
    // backend, but the user-facing model is "archive, not destroy" — you
    // can always bring it back. Permanent delete is a future operation.
    //
    // updated_at is bumped on every turn so the sidebar can sort "most
    // recent first" without re-querying the persistence layer.
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
      CREATE INDEX idx_conversations_archived ON conversations(archived);
    `,
  },
  {
    version: 4,
    // Cache markdown body on the todos row itself so FTS5 snippet() can
    // find something to highlight. The external-content FTS5 table reads
    // the `body` column directly from `todos`, so storing the markdown
    // here is what makes search() snippets non-empty. content_versions
    // remains the authoritative history (only the latest body is mirrored).
    sql: `
      ALTER TABLE todos ADD COLUMN body TEXT NOT NULL DEFAULT '';

      DROP TRIGGER IF EXISTS todos_fts_insert;
      DROP TRIGGER IF EXISTS todos_fts_delete;
      DROP TRIGGER IF EXISTS todos_fts_update;

      CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
        INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body)
          VALUES('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body)
          VALUES('delete', old.rowid, old.title, old.body);
        INSERT INTO todos_fts(rowid, title, body)
          VALUES (new.rowid, new.title, new.body);
      END;
    `,
  },
  {
    version: 5,
    // SubTask support: a todo can now have a parent todo (parent_id).
    // The model is "tasks can have sub-tasks, but groups can NOT be children
    // of tasks" (a group is a directory; a task is a file). Self-FK with
    // ON DELETE SET NULL so deleting a parent promotes its subtasks to
    // top-level rather than cascading — subtasks are independent units of
    // work that should survive the parent's deletion.
    //
    // We do NOT use a CYCLE prevention check (SQLite supports it via WITH
    // RECURSIVE but the cost is high for a common query). Instead the
    // application layer (todo.update) refuses to set parent_id to a
    // descendant of the current todo before issuing the UPDATE.
    sql: `
      ALTER TABLE todos ADD COLUMN parent_id TEXT;
      CREATE INDEX idx_todos_parent ON todos(parent_id);
    `,
  },
  {
    version: 6,
    // Remove the Group concept entirely. Everything is a Task now; a Task may
    // have SubTasks via parent_id (added in v5). Former groups become top-level
    // tasks; the tasks that were filed under a group become that group's
    // SubTasks, preserving the hierarchy as a pure Task tree.
    //
    // body_path is NOT NULL but vestigial — MarkdownStore.readBody computes the
    // real path from the id and tolerates a missing file, so former groups get a
    // placeholder body_path (and body='', the FTS mirror). No .md file is needed.
    //
    // Ordering matters for the self-FK parent_id → todos(id): we insert all
    // former groups AS tasks FIRST (step 1, parent_id NULL), then re-link
    // parent_id in a separate UPDATE so every referenced id already exists
    // when the FK check runs.
    sql: `
      -- 1. Insert each former group as a top-level Task (parent_id NULL for
      --    now; step 2 re-links sub-groups to their parent). The WHERE NOT
      --    EXISTS guards against the (ULID-collision-impossible) case where a
      --    group id already exists as a todo id.
      INSERT INTO todos (id, title, status, priority, project, due_at, body_path, body, created_at, updated_at, done_at, parent_id)
      SELECT g.id, g.name, 'inbox', 'none', NULL, NULL,
             'todos/' || g.id || '.md', '', g.created_at, g.created_at, NULL, NULL
      FROM groups g
      WHERE NOT EXISTS (SELECT 1 FROM todos t WHERE t.id = g.id);

      -- 2. Re-link former sub-groups as subtasks of their parent group (now a
      --    task). All group ids are already in todos after step 1.
      UPDATE todos
      SET parent_id = (SELECT g.parent_id FROM groups g WHERE g.id = todos.id)
      WHERE id IN (SELECT id FROM groups WHERE parent_id IS NOT NULL);

      -- 3. Former member tasks: adopt their group as the parent task. Tasks
      --    that already had a parent_id (were already SubTasks) keep it; the
      --    rest get parent_id = their group_id. This turns the old
      --    group→task→subtask chain into a uniform task→task→subtask tree.
      UPDATE todos
      SET parent_id = group_id
      WHERE group_id IS NOT NULL AND parent_id IS NULL;

      -- 4. Drop the now-obsolete groups table, its index, and the group_id
      --    column. group_id has no FK (v2 added it as a plain TEXT column) and
      --    is only indexed by idx_todos_group, so DROP INDEX must precede
      --    DROP COLUMN.
      DROP INDEX IF EXISTS idx_todos_group;
      DROP TABLE IF EXISTS groups;
      ALTER TABLE todos DROP COLUMN group_id;
    `,
  },
  {
    version: 7,
    // Auto-archive: a task can be soft-archived (archived_at) so finished
    // work declutters the active list without being deleted. Orthogonal to
    // status — a done task "completed > N days ago" is auto-archived by the
    // boot sweep (see index.ts); the user can still find/restore it from the
    // 归档 view. null = active (the common case). Indexed so the default
    // "WHERE archived_at IS NULL" list query stays cheap as the table grows.
    sql: `
      ALTER TABLE todos ADD COLUMN archived_at INTEGER;
      CREATE INDEX idx_todos_archived ON todos(archived_at);
    `,
  },
  {
    version: 8,
    // Status enum cleanup. The old 'inbox' state was confusing (the 收件箱
    // label read as "a place" rather than a lifecycle stage); it collapses
    // into 'next' (未完成). A new 'cancelled' (已取消) state is added for
    // dropped/void work. Final enum: next | doing | done | cancelled | blocked.
    //
    // SQLite can't ALTER a CHECK constraint in place, so we rebuild the
    // todos table: create a copy with the updated CHECK, preserve rowids
    // (so the FTS5 content_rowid mapping stays valid), migrate inbox→next,
    // drop the old table + its triggers/indexes, rename, recreate indexes
    // + triggers. The external-content FTS5 table (todos_fts) is KEPT —
    // its content='todos' binding re-resolves by name to the rebuilt table.
    // DO NOT drop+recreate todos_fts inside the migration transaction: doing
    // so leaves the FTS5 shadow tables inconsistent and subsequent trigger
    // ops throw SQLITE_CORRUPT ("database disk image is malformed"). Instead
    // we keep the FTS5 table and run 'rebuild' to repopulate it from the
    // rebuilt content table. FK enforcement is OFF for the whole migration
    // phase (see openDb) so DROP TABLE todos doesn't cascade-delete the
    // tags/drawings/content_versions/inbox_attachments children.
    sql: `
      CREATE TABLE todos_new (
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
        FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE SET NULL
      );

      INSERT INTO todos_new (rowid, id, title, status, priority, project, due_at, body_path, body, created_at, updated_at, done_at, parent_id, archived_at)
      SELECT rowid, id, title, CASE status WHEN 'inbox' THEN 'next' ELSE status END,
             priority, project, due_at, body_path, body, created_at, updated_at, done_at, parent_id, archived_at
      FROM todos;

      -- Drop the FTS + touch triggers BEFORE the content table so they
      -- don't fire during the rebuild, then DROP the old todos table
      -- (which also drops its indexes — index names are global in SQLite,
      -- so the old table must go before we recreate same-named indexes).
      DROP TRIGGER IF EXISTS todos_fts_insert;
      DROP TRIGGER IF EXISTS todos_fts_delete;
      DROP TRIGGER IF EXISTS todos_fts_update;
      DROP TRIGGER IF EXISTS trg_touch_updated_at;
      DROP TABLE todos;
      ALTER TABLE todos_new RENAME TO todos;

      CREATE INDEX idx_todos_status ON todos(status);
      CREATE INDEX idx_todos_due_at ON todos(due_at);
      CREATE INDEX idx_todos_project ON todos(project);
      CREATE INDEX idx_todos_updated_at ON todos(updated_at DESC);
      CREATE INDEX idx_todos_parent ON todos(parent_id);
      CREATE INDEX idx_todos_archived ON todos(archived_at);

      CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
        INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
        INSERT INTO todos_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;

      -- NOTE: the old trg_touch_updated_at AFTER UPDATE self-UPDATE trigger is
      -- intentionally NOT recreated. After a content-table rebuild, an AFTER
      -- UPDATE trigger that itself UPDATEs the same row interacts with the
      -- FTS5 external-content shadow tables and corrupts them ("database disk
      -- image is malformed"). updated_at stamping now lives in the app layer
      -- (TodoRepo.update always sets updated_at = now).

      -- Repopulate the kept FTS5 index from the rebuilt content table.
      INSERT INTO todos_fts(todos_fts) VALUES('rebuild');
    `,
  },
];

export interface DbHandle {
  db: Database.Database;
  close(): void;
}

export function openDb(filePath: string): DbHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Disable FK enforcement for the migration phase so a rebuild migration
  // (which DROPs + recreates tables referenced by FKs, e.g. the v8 todos
  // rebuild) doesn't cascade-delete child rows. PRAGMA foreign_keys is a
  // no-op inside a transaction, so it must be set here — outside the
  // per-migration transactions below. Re-enabled once migrations complete.
  db.pragma('foreign_keys = OFF');

  // Fresh DB has no schema_meta; the query fails with "no such table" until
  // the first migration creates it. Treat any error as v0 and let the loop
  // below run all migrations.
  let currentVersion = 0;
  try {
    const row = db
      .prepare<[], { version: number | null }>('SELECT MAX(version) as version FROM schema_meta')
      .get();
    currentVersion = row?.version ?? 0;
  } catch {
    currentVersion = 0;
  }

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT OR REPLACE INTO schema_meta(version) VALUES (?)').run(m.version);
      });
      tx();
    }
  }
  // Re-enable FK enforcement for normal runtime now that migrations are done.
  db.pragma('foreign_keys = ON');

  // close() is idempotent: the data-migration path closes the DB early, and
  // before-quit calls close() again — double-close on better-sqlite3 throws.
  let closed = false;
  return {
    db,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** Generate a new ULID. Exposed for tests and the repo. */
export const newId = ulid;