// SQLite schema + migrations. Sole authority for runtime state.
// Files (Markdown, Excalidraw JSON) are projected FROM this DB; DB is the truth.

import Database from 'better-sqlite3';
import ulidPkg from 'ulid';
const { ulid } = ulidPkg;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 16;

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
  {
    version: 9,
    // Soft-delete (快速恢复 / quick recovery). A task can be logically
    // deleted (deleted_at) so the row + its markdown/drawings survive for
    // undo. Deletion cascades to the whole subtree (the repo's delete()
    // stamps deleted_at on the task + every descendant via a recursive
    // CTE); restore(id) clears it for the subtree. The default list excludes
    // deleted tasks; the 已删除 filter view surfaces them (deletedOnly).
    //
    // A nullable column ADD is enough — no CHECK, no rebuild, no FTS churn.
    // Search/stats exclude deleted rows so they don't leak into results.
    sql: `
      ALTER TABLE todos ADD COLUMN deleted_at INTEGER;
      CREATE INDEX idx_todos_deleted ON todos(deleted_at);
    `,
  },
  {
    version: 10,
    // Progress system. Each task carries a `progress` percent (0–100,
    // default 0) on the todos row for at-a-glance bar rendering, plus a
    // `progress_log` audit table recording every change (percent + optional
    // one-line note + timestamp). The user-facing "录入进展" path is
    // progress.log() (sets the column + appends a log row with a note);
    // todo.update({progress}) sets the column AND appends a note-less log row
    // when the value actually changes, so the timeline stays a complete audit
    // of every progress mutation regardless of source (AI tool, batch op, UI).
    //
    // ALTER TABLE ADD COLUMN is safe here — no FTS rebuild, no trigger churn.
    // The FTS triggers only reference title/body, never progress, so adding a
    // column can't corrupt the external-content shadow tables (see the
    // trg-touch-fts5-corruption note in memory: only a self-UPDATE trigger
    // after a content-table rebuild is the danger; neither applies here).
    sql: `
      ALTER TABLE todos ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE progress_log (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        percent INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_progress_log_todo ON progress_log(todo_id, created_at DESC);
    `,
  },
  {
    version: 11,
    // Multi-document workspace. Each task owns a list of `task_documents`
    // rows (kind ∈ progress | note_md | drawing | attachment | link). The
    // default `progress` doc is auto-created for every todo; the existing
    // single .md body is migrated into a `note_md` doc with its full
    // content_versions history copied into `document_versions` (re-keyed to
    // the new doc id), so no user content is lost.
    //
    // Content for progress / note_md lives in `document_versions` (DB text,
    // same pattern as the legacy content_versions table — no file-path
    // management, no file-migration churn). Drawings / attachments / links
    // carry no versioned content here; their content is referenced via refId
    // / url and managed by their own stores.
    //
    // Ids for migrated/default docs are deterministic ('<todoId>:progress',
    // '<todoId>:note_md') so the INSERT...NOT EXISTS guards make this
    // idempotent; user-created docs get ULIDs from DocumentStore.create.
    //
    // Pure DDL + data-copy migration — no FTS / trigger churn, safe.
    sql: `
      CREATE TABLE task_documents (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('progress','note_md','drawing','attachment','link')),
        title TEXT,
        ref_id TEXT,
        url TEXT,
        ord INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_task_docs_todo ON task_documents(todo_id, ord);

      CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        content TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES task_documents(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_doc_versions_doc ON document_versions(document_id, saved_at DESC);

      -- Default WYSIWYG progress doc for every existing todo (ord 0).
      INSERT INTO task_documents (id, todo_id, kind, title, ref_id, url, ord, created_at, updated_at)
      SELECT id || ':progress', id, 'progress', '进展', NULL, NULL, 0, created_at, created_at
      FROM todos
      WHERE NOT EXISTS (SELECT 1 FROM task_documents d WHERE d.id = todos.id || ':progress');

      -- Migrate the existing .md body (mirrored on todos.body) into a note_md
      -- doc, for todos that actually have content. Deterministic id => idempotent.
      INSERT INTO task_documents (id, todo_id, kind, title, ref_id, url, ord, created_at, updated_at)
      SELECT id || ':note_md', id, 'note_md', '笔记', NULL, NULL, 1, created_at, created_at
      FROM todos
      WHERE body != ''
        AND NOT EXISTS (SELECT 1 FROM task_documents d WHERE d.id = todos.id || ':note_md');

      -- Copy the full content_versions history for the migrated note_md docs,
      -- re-keyed to the new document id. Preserves every saved version.
      INSERT INTO document_versions (document_id, content, saved_at)
      SELECT cv.todo_id || ':note_md', cv.body, cv.saved_at
      FROM content_versions cv
      WHERE EXISTS (SELECT 1 FROM task_documents d WHERE d.id = cv.todo_id || ':note_md');
    `,
  },
  {
    version: 12,
    // Link preview text. Link-kind task_documents can now carry a short
    // `description` (the page's <meta description> / og:description), shown as
    // a subtitle under the link title in the detail's 链接 section. Fetched
    // best-effort by the link.fetchMeta handler when the user adds a link;
    // nullable because not every page has one and the fetch can fail.
    //
    // A nullable ADD COLUMN is safe — no FTS / trigger references task_documents,
    // so there's no external-content shadow-table churn.
    sql: `
      ALTER TABLE task_documents ADD COLUMN description TEXT;
    `,
  },
  {
    version: 13,
    // "今日待办" stamp. A task may carry a `planned_for` value (the local
    // date it's planned for, as `YYYY-MM-DD`, or null). The renderer's
    // 双区域 view splits the list into 今日待办 (rows where planned_for
    // equals today's local date) and 其他任务 (everything else); equality
    // (not range) so yesterday's stamp naturally drops off tomorrow morning
    // without any sweep. Indexed because the upper-section query "WHERE
    // planned_for = todayKey" runs on every list render.
    //
    // Nullable ADD COLUMN is safe here for the same reasons as v9/v10/v12:
    // the FTS triggers only touch title/body, and there's no self-UPDATE
    // trigger that could interact with the external-content shadow tables.
    //
    // Originally introduced as an INTEGER (epoch ms of local 00:00) in
    // v13; corrected to TEXT (local-date string) in v14 — see that
    // migration's comment for the rationale.
    sql: `
      ALTER TABLE todos ADD COLUMN planned_for INTEGER;
      CREATE INDEX idx_todos_planned_for ON todos(planned_for);
    `,
  },
  {
    version: 14,
    // planned_for: INTEGER (epoch ms of local 00:00) → TEXT (local date
    // 'YYYY-MM-DD'). Date strings are tz-stable (the value you wrote is the
    // value you read, regardless of where the laptop wakes up later), and
    // make SQL reads human-grokkable (`WHERE planned_for = '2026-09-11'`).
    //
    // SQLite can't ALTER COLUMN, so we copy rows into a new table, swap
    // them, and rebuild the index. The conversion: for any non-null
    // INTEGER value, format the corresponding local-date 'YYYY-MM-DD' using
    // the stored epoch ms (interpreted in the SYSTEM's local timezone at
    // upgrade time, which is the only sensible choice — the ms was originally
    // computed as Date#setHours(0,0,0,0) in the user's local tz). Nulls
    // stay null. Done in one transaction so a partial migration can never
    // be observed.
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
        deleted_at INTEGER,
        progress INTEGER NOT NULL DEFAULT 0,
        planned_for TEXT,
        FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE SET NULL
      );

      INSERT INTO todos_new (id, title, status, priority, project, due_at, body_path, body,
                             created_at, updated_at, done_at, parent_id, archived_at, deleted_at,
                             progress, planned_for)
      SELECT id, title, status, priority, project, due_at, body_path, body,
             created_at, updated_at, done_at, parent_id, archived_at, deleted_at,
             progress,
             CASE
               WHEN planned_for IS NULL THEN NULL
               WHEN typeof(planned_for) = 'text' THEN planned_for
               ELSE strftime('%Y-%m-%d', planned_for / 1000, 'unixepoch', 'localtime')
             END
      FROM todos;

      -- Drop the FTS triggers BEFORE the content table — otherwise they
      -- dangle and corrupt the external-content shadow tables on the
      -- rebuild. Same pattern as the v8 migration.
      DROP TRIGGER IF EXISTS todos_fts_insert;
      DROP TRIGGER IF EXISTS todos_fts_delete;
      DROP TRIGGER IF EXISTS todos_fts_update;

      DROP TABLE todos;
      ALTER TABLE todos_new RENAME TO todos;

      -- v13's index has the same name but is implicitly dropped with the old
      -- table; recreate it against the TEXT column.
      CREATE INDEX idx_todos_planned_for ON todos(planned_for);

      -- Recreate the FTS triggers against the rebuilt content table. The
      -- external-content FTS5 table (todos_fts) is preserved across the
      -- rebuild — its content='todos' binding re-resolves by name. We end
      -- with a 'rebuild' so the shadow tables catch up to the new content.
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

      -- The v14 migration never touches title/body — it only renames the
      -- planned_for column from INTEGER to TEXT. The external-content FTS5
      -- shadow tables (todos_fts) are still consistent with the content
      -- table from the prior boot, and the triggers above keep them in
      -- sync for all subsequent INSERT/UPDATE/DELETE. We deliberately do
      -- NOT run 'INSERT INTO todos_fts(todos_fts) VALUES(''rebuild'')' here
      -- the way v8 did — that command tokenizes every row's title+body
      -- synchronously and made first-boot-after-upgrade hang the window
      -- open for several seconds on databases with hundreds of todos
      -- (Windows reported the app as 未响应 during the rebuild). The new
      -- triggers cover ongoing writes; if shadow tables ever drift, the
      -- user can recover with a manual 'rebuild' from a sqlite shell.
    `,
  },
  {
    version: 15,
    // Stable DB-backed association between a todo and its directory under
    // {dataDir}/todos.  It is intentionally independent from the title:
    // title changes may rename the directory, but a failed filesystem rename
    // must leave the association pointing at the original directory.
    sql: `
      ALTER TABLE todos ADD COLUMN storage_dir TEXT;
      CREATE UNIQUE INDEX idx_todos_storage_dir ON todos(storage_dir)
        WHERE storage_dir IS NOT NULL;
    `,
  },
  {
    version: 16,
    // Drop the `project` concept. The column has been a dead field since the
    // Group/SubTask refactor (the sidebar / filter popover both read from
    // `tags`, never from `project`). Removing the column + index shrinks the
    // todo row and lets the todo.create / todo.update surfaces stop carrying
    // a parameter the UI never surfaced.
    //
    // SQLite 3.35+ supports `ALTER TABLE ... DROP COLUMN` (and bundled
    // better-sqlite3 ships a SQLite new enough); the index goes first so
    // the DROP COLUMN doesn't fail with "indexed column cannot be dropped".
    sql: `
      DROP INDEX IF EXISTS idx_todos_project;
      ALTER TABLE todos DROP COLUMN project;
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
