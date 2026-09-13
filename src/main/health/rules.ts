// QUALITY-01 — task health rules.
//
// Deterministic, AI-free. Each rule scans a slice of `todos` and
// produces 0+ `HealthIssue` rows. The renderer / settings pane is
// responsible for showing them; AI explanation / suggested fixes
// are deliberately out of scope here (that belongs to AI-01 or a
// later task).

import type Database from 'better-sqlite3';
import type { TodoStatus, Priority } from '../../shared/todo-types';

/** Local-date helper for `planned_for` (stored as `YYYY-MM-DD`). */
function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Severity tiers. Used by the UI to sort + colour. */
export type HealthSeverity = 'info' | 'warn' | 'blocker';

/** A single observation. The `kind` is a stable id so the renderer
 *  can group / suppress / act-on per kind (e.g. a future "snooze
 *  this rule for 7 days" toggle). */
export interface HealthIssue {
  /** Stable id for the rule that produced this issue. */
  kind:
    | 'long_doing_no_progress'
    | 'overdue'
    | 'blocked_no_reason'
    | 'parent_done_child_open'
    | 'progress_status_conflict'
    | 'today_overload';
  /** Severity for UI ordering. */
  severity: HealthSeverity;
  /** Todo ids implicated. The renderer can deep-link to each. */
  todoIds: string[];
  /** Human-readable Chinese explanation (no PII, no absolute paths). */
  message: string;
  /** Optional rule-specific payload — e.g. for `today_overload` this
   *  carries the count + threshold so the UI can show "已超载 5 个
   *  (阈值 10)". */
  data?: Record<string, number | string>;
}

export interface HealthRuleOptions {
  /** `now` for deterministic tests. */
  now?: Date;
  /** Threshold for `long_doing_no_progress`: a `doing` task whose
   *  `updated_at` is older than this is flagged. Default 7 days. */
  longDoingMs?: number;
  /** Threshold for `today_overload`: more than N tasks planned for
   *  today triggers the rule. Default 10. */
  todayOverloadThreshold?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function runHealthRules(
  db: Database.Database,
  opts: HealthRuleOptions = {},
): HealthIssue[] {
  const now = opts.now ?? new Date();
  const longDoingMs = opts.longDoingMs ?? 7 * DAY_MS;
  const todayOverloadThreshold = opts.todayOverloadThreshold ?? 10;
  const nowMs = now.getTime();
  const today = localToday(now);
  const issues: HealthIssue[] = [];

  // ---- 1. 长期 doing 无进展 -------------------------------------------
  {
    const rows = db
      .prepare<[number], { id: string; title: string; updated_at: number }>(
        `SELECT id, title, updated_at FROM todos
         WHERE deleted_at IS NULL AND status = 'doing'
           AND updated_at < ?`,
      )
      .all(nowMs - longDoingMs);
    if (rows.length > 0) {
      issues.push({
        kind: 'long_doing_no_progress',
        severity: 'warn',
        todoIds: rows.map((r) => r.id),
        message: `${rows.length} 个「进行中」任务超过 7 天没有进展。`,
        data: { count: rows.length, days: 7 },
      });
    }
  }

  // ---- 2. 已过期 -------------------------------------------------------
  {
    const todayMs = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    );
    const rows = db
      .prepare<[number], { id: string; title: string; due_at: number }>(
        `SELECT id, title, due_at FROM todos
         WHERE deleted_at IS NULL
           AND due_at IS NOT NULL AND due_at < ?
           AND status IN ('next','doing','blocked')`,
      )
      .all(todayMs);
    if (rows.length > 0) {
      issues.push({
        kind: 'overdue',
        severity: 'warn',
        todoIds: rows.map((r) => r.id),
        message: `${rows.length} 个未完成任务已过截止日期。`,
        data: { count: rows.length },
      });
    }
  }

  // ---- 3. blocked 无说明 ----------------------------------------------
  {
    const rows = db
      .prepare<[], { id: string; title: string }>(
        `SELECT id, title FROM todos
         WHERE deleted_at IS NULL AND status = 'blocked'
           AND (body IS NULL OR length(trim(body)) < 10)`,
      )
      .all();
    if (rows.length > 0) {
      issues.push({
        kind: 'blocked_no_reason',
        severity: 'info',
        todoIds: rows.map((r) => r.id),
        message: `${rows.length} 个「阻塞」任务没有说明原因。`,
        data: { count: rows.length },
      });
    }
  }

  // ---- 4. 父任务完成但子任务未完成 ------------------------------------
  {
    // Each returned row = one parent who has at least one open child.
    const rows = db
      .prepare<[], { id: string; open_children: number }>(
        `SELECT p.id, COUNT(c.id) AS open_children
         FROM todos p
         JOIN todos c ON c.parent_id = p.id
            AND c.deleted_at IS NULL
            AND c.status NOT IN ('done','cancelled')
         WHERE p.deleted_at IS NULL AND p.status = 'done'
         GROUP BY p.id`,
      )
      .all();
    if (rows.length > 0) {
      const totalOpen = rows.reduce((s, r) => s + r.open_children, 0);
      issues.push({
        kind: 'parent_done_child_open',
        severity: 'blocker',
        todoIds: rows.map((r) => r.id),
        message: `${rows.length} 个「已完成」任务的 ${totalOpen} 个子任务仍未完成。`,
        data: { parentCount: rows.length, childCount: totalOpen },
      });
    }
  }

  // ---- 5. progress / status 矛盾 --------------------------------------
  {
    const rows = db
      .prepare<[], { id: string; progress: number; status: TodoStatus }>(
        `SELECT id, progress, status FROM todos
         WHERE deleted_at IS NULL
           AND (
             (status = 'done' AND progress < 100)
             OR (status != 'done' AND status != 'cancelled' AND progress >= 100)
           )`,
      )
      .all();
    if (rows.length > 0) {
      issues.push({
        kind: 'progress_status_conflict',
        severity: 'warn',
        todoIds: rows.map((r) => r.id),
        message: `${rows.length} 个任务的进度与状态不一致（如「已完成」但 progress < 100，或 progress = 100 但状态不是已完成）。`,
        data: { count: rows.length },
      });
    }
  }

  // ---- 6. Today 超载 --------------------------------------------------
  {
    const rows = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM todos
         WHERE deleted_at IS NULL AND planned_for = ?`,
      )
      .get(today);
    const count = rows?.c ?? 0;
    if (count > todayOverloadThreshold) {
      issues.push({
        kind: 'today_overload',
        severity: 'info',
        todoIds: [],
        message: `今日待办排了 ${count} 个任务（阈值 ${todayOverloadThreshold}），考虑分批或重新规划。`,
        data: { count, threshold: todayOverloadThreshold },
      });
    }
  }

  // ---- severity / kind ordering ---------------------------------------
  // Deterministic order so the UI doesn't shuffle between calls.
  const severityOrder: Record<HealthSeverity, number> = {
    blocker: 0,
    warn: 1,
    info: 2,
  };
  issues.sort((a, b) => {
    const sa = severityOrder[a.severity];
    const sb = severityOrder[b.severity];
    if (sa !== sb) return sa - sb;
    return a.kind.localeCompare(b.kind);
  });

  return issues;
}

/** Re-exported for the renderer-side TypeScript types. */
export type { TodoStatus, Priority };