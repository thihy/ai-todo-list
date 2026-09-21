// ConversationRepo — CRUD for the `conversations` table.
//
// Each row is a user-visible AI thread (a "conversation"). The DB holds only
// metadata (title, timestamps, archived flag). The full event log lives in
// the dsh-session-persistence-jsonl backend (see resources/dsh/cordis.yml:
// session-persistence). DB row ↔ JSONL file is keyed by id — the conversation
// id IS the SessionId.
//
// Operations:
//   list({includeArchived, limit, offset}) → rows sorted by updated_at DESC
//   count(includeArchived=false) → total matching rows
//   get(id) → row or undefined
//   create({title?}) → new row with auto-generated title default
//   rename(id, title) → updates title + bumps updated_at
//   touch(id) → bumps updated_at (called after each AI turn)
//   archive(id) → soft delete (archived = 1); JSONL is NOT touched
//   unarchive(id) → restore an archived conversation
//   delete(id) → hard delete one DB row; caller responsible for JSONL
//   deleteMany(ids) → hard delete many DB rows; caller responsible for JSONL
//   sweep(maxCount) → when active count > max, hard delete the oldest
//                     unarchived rows down to the cap. Caller responsible
//                     for any leaked JSONL (sweep is a pure DB op).
//   setPermissionPreset(id, preset) → store the user's permission-preset
//                     choice (v20). Does not bump updated_at.
//
// Notes:
// - updated_at is bumped on every state mutation so the sidebar can sort
//   "most recent first" without scanning JSONL files for mtime.
// - archived ≠ deleted: the JSONL is preserved across archive, and the
//   conversation can still be loaded by id (e.g. via `unarchive`). The
//   sidebar hides archived rows by default.
// - delete / deleteMany / sweep are all "DB-only" — the on-disk JSONL is
//   not touched. The single `ai.conversation.delete` handler runs the
//   JSONL cleanup pass; for batch + sweep the renderer is expected to
//   accept that leaked JSONL will be picked up by the next backup pass
//   or by `Settings → 数据 → 数据备份` snapshots. Keeping the sweep path
//   pure-DB avoids a runtime-boot dependency on the create handler.
import type Database from 'better-sqlite3';
import { newId } from './schema';

/** AI 助手侧边栏的「对话列表」默认每页 10 条 —— 初次打开下拉只看到最近 10 条，
 *  用户点「显示更多」再向后翻一页。 */
export const DEFAULT_CONVERSATION_LIST_LIMIT = 10;
/** 安全上限：渲染端即使传来 limit=999，main 也只给 50 条。
 *  防止单次查询撑爆 IPC / 渲染端内存。 */
export const MAX_CONVERSATION_LIST_LIMIT = 50;

export interface ConversationListOpts {
  includeArchived?: boolean;
  /** 每页条数；缺省 {@link DEFAULT_CONVERSATION_LIST_LIMIT}，超过
   *  {@link MAX_CONVERSATION_LIST_LIMIT} 时夹到上限。 */
  limit?: number;
  /** 从第几条开始；缺省 0。 */
  offset?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** 用户为这条会话选的权限预设（read-only / workspace-write / auto /
   *  danger-full-access）。null = 从未显式选过 → 走 cordis.yml 的
   *  defaultPreset。见 schema.ts v20 migration 的注释：这一列是「用户
   *  意图」，DSH session 的 permission/preset 事件才是「实际生效」，
   *  两者在首轮 ensureAgent() 时对齐。 */
  permissionPreset: string | null;
}

interface Row {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
  permission_preset: string | null;
}

function rowToConversation(r: Row): Conversation {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: r.archived === 1,
    permissionPreset: r.permission_preset ?? null,
  };
}

/** 把渲染端传入的 limit 夹到合法区间。负数 / NaN / 0 一律回退到默认。 */
function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw as number) <= 0) return DEFAULT_CONVERSATION_LIST_LIMIT;
  return Math.min(Math.floor(raw as number), MAX_CONVERSATION_LIST_LIMIT);
}

export class ConversationRepo {
  constructor(private readonly db: Database.Database) {}

  /** 命中行数；{@link ConversationListOpts.includeArchived} 与 `list()` 一致。 */
  count(includeArchived = false): number {
    const sql = includeArchived
      ? 'SELECT COUNT(*) as c FROM conversations'
      : 'SELECT COUNT(*) as c FROM conversations WHERE archived = 0';
    const row = this.db.prepare(sql).get() as { c: number };
    return row.c;
  }

  /** 按 `updated_at DESC` 取一页对话。{@link ConversationListOpts.includeArchived}
   *  默认 false（侧边栏隐藏归档）。limit/offset 均做了夹紧。 */
  list(opts: ConversationListOpts = {}): Conversation[] {
    const includeArchived = opts.includeArchived === true;
    const limit = clampLimit(opts.limit);
    const offset = Number.isFinite(opts.offset) && (opts.offset as number) >= 0
      ? Math.floor(opts.offset as number)
      : 0;
    const sql = includeArchived
      ? 'SELECT id, title, created_at, updated_at, archived, permission_preset FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      : 'SELECT id, title, created_at, updated_at, archived, permission_preset FROM conversations WHERE archived = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    const rows = this.db.prepare(sql).all(limit, offset) as Row[];
    return rows.map(rowToConversation);
  }

  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare('SELECT id, title, created_at, updated_at, archived, permission_preset FROM conversations WHERE id = ?')
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
    return { id, title, createdAt: now, updatedAt: now, archived: false, permissionPreset: null };
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

  /**
   * Persist the user's permission-preset choice for this conversation.
   *
   * Deliberately does NOT bump updated_at: switching the preset is a
   * configuration act, not a content mutation, so it must not reorder the
   * sidebar (same rationale as `todo.setSelectedDoc` / the v18 migration).
   *
   * `preset === null` clears the choice back to "never explicitly selected"
   * → the next turn falls back to the cordis.yml defaultPreset. Returns
   * whether a row actually changed (false for unknown id / archived row).
   */
  setPermissionPreset(id: string, preset: string | null): boolean {
    const res = this.db
      .prepare('UPDATE conversations SET permission_preset = ? WHERE id = ?')
      .run(preset, id);
    return res.changes > 0;
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

  /**
   * Hard delete many DB rows in one statement. Empty array / unknown ids
   * are no-ops. Returns the number of rows actually removed (always ≤
   * `ids.length`). Does NOT touch the on-disk JSONL — caller is responsible.
   */
  deleteMany(ids: string[]): number {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    // 占位符动态拼装 —— 仍然走 prepare + 参数绑定，不走字符串拼接值
    // （值是 ?，不是直接拼 id，避免任何注入风险）。
    const placeholders = ids.map(() => '?').join(',');
    const res = this.db
      .prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`)
      .run(...ids);
    return res.changes;
  }

  /**
   * Cap enforcement: when the active (unarchived) count exceeds `maxCount`,
   * hard-delete the oldest rows by `updated_at ASC` until we're back under
   * the cap. `maxCount <= 0` means "unlimited" → no-op. Archived rows are
   * never swept — they're "kept but hidden" by the user. Returns the list
   * of swept conversation ids so callers can also clean per-conv side
   * effects (composer inbox files, etc). The on-disk JSONL of swept rows
   * is still left as a ghost — the renderer accepts this trade-off to
   * keep `ai.conversation.create` free of a runtime-boot dependency.
   */
  sweep(maxCount: number): string[] {
    if (!Number.isFinite(maxCount) || maxCount <= 0) return [];
    const current = this.count(false); // 仅未归档
    if (current <= maxCount) return [];
    const overflow = current - maxCount;
    const selectIds = this.db
      .prepare<[number]>(
        `SELECT id FROM conversations
         WHERE archived = 0
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(overflow) as Array<{ id: string }>;
    const ids = selectIds.map((r) => r.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`)
      .run(...ids);
    return ids;
  }
}