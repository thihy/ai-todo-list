// ConversationRepo — CRUD for the `conversations` table.
//
// Each row is a user-visible AI thread (a "conversation"). The DB holds only
// metadata (title, timestamps, archived flag). The full event log lives in
// the dsh-session-persistence-jsonl backend (see resources/dsh/cordis.yml:
// session-persistence). DB row ↔ JSONL file is keyed by id — the conversation
// id IS the SessionId.
//
// Operations:
//   list(includeArchived=false) → rows sorted by updated_at DESC
//   get(id) → row or undefined
//   create({title?}) → new row with auto-generated title default
//   rename(id, title) → updates title + bumps updated_at
//   touch(id) → bumps updated_at (called after each AI turn)
//   archive(id) → soft delete (archived = 1); JSONL is NOT touched
//   unarchive(id) → restore an archived conversation
//   delete(id) → hard delete the DB row; caller is responsible for the
//                JSONL (or leave it as a "ghost" — list() filters archived
//                but the on-disk log remains so the user can inspect).
//
// Notes:
// - updated_at is bumped on every state mutation so the sidebar can sort
//   "most recent first" without scanning JSONL files for mtime.
// - archived ≠ deleted: the JSONL is preserved across archive, and the
//   conversation can still be loaded by id (e.g. via `unarchive`). The
//   sidebar hides archived rows by default.
import type Database from 'better-sqlite3';
import { newId } from './schema';

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

interface Row {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
}

function rowToConversation(r: Row): Conversation {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: r.archived === 1,
  };
}

export class ConversationRepo {
  constructor(private readonly db: Database.Database) {}

  /** List conversations; archived rows excluded unless includeArchived. */
  list(includeArchived = false): Conversation[] {
    const sql = includeArchived
      ? 'SELECT id, title, created_at, updated_at, archived FROM conversations ORDER BY updated_at DESC'
      : 'SELECT id, title, created_at, updated_at, archived FROM conversations WHERE archived = 0 ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all() as Row[];
    return rows.map(rowToConversation);
  }

  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare('SELECT id, title, created_at, updated_at, archived FROM conversations WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  /**
   * Create a new conversation row. Default title is "新对话" with the current
   * timestamp suffix so two consecutive creates don't look identical in the
   * sidebar before the user renames either. The caller can pass an explicit
   * title to skip the default.
   */
  create(opts?: { title?: string }): Conversation {
    const id = newId();
    const now = Date.now();
    const title = opts?.title ?? `新对话 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`;
    this.db
      .prepare(
        'INSERT INTO conversations(id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0)',
      )
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now, archived: false };
  }

  rename(id: string, title: string): boolean {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('conversation title cannot be empty');
    const res = this.db
      .prepare(
        'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND archived = 0',
      )
      .run(trimmed, Date.now(), id);
    return res.changes > 0;
  }

  /** Bump updated_at — called when a new turn lands on this conversation. */
  touch(id: string): void {
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  archive(id: string): boolean {
    const res = this.db
      .prepare('UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0')
      .run(Date.now(), id);
    return res.changes > 0;
  }

  unarchive(id: string): boolean {
    const res = this.db
      .prepare('UPDATE conversations SET archived = 0, updated_at = ? WHERE id = ? AND archived = 1')
      .run(Date.now(), id);
    return res.changes > 0;
  }

  /**
   * Hard delete the DB row. Does NOT touch the on-disk JSONL — that's the
   * persistence backend's job (and out of scope here: the JSONL backend
   * exposes no per-id delete; if we need it, future work can walk the
   * <DSH_SESSIONS_ROOT>/<project>/<id>/ dir and rm it). For now "delete"
   * in the UI should call `archive()` instead.
   */
  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.changes > 0;
  }
}