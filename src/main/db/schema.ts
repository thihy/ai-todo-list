// SQLite schema + migrations. Sole authority for runtime state.
// Files (Markdown, Excalidraw JSON) are projected FROM this DB; DB is the truth.

import Database from 'better-sqlite3';
import ulidPkg from 'ulid';
const { ulid } = ulidPkg;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 4;

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
];

export interface DbHandle {
  db: Database.Database;
  close(): void;
}

export function openDb(filePath: string): DbHandle {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

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