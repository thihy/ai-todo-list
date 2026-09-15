// TodoRepo: thin layer over the todos table + tags + drawing aggregation + FTS search.

import type Database from 'better-sqlite3';
import { newId } from './schema';
import type {
  Priority,
  ProgressLogEntry,
  SearchHit,
  Todo,
  TodoCreate,
  TodoFilter,
  TodoPatch,
  TodoStats,
  TodoStatus,
  ULID,
} from '../../shared/todo-types';

/** Burst-merge window for progress_log: when a user drags the bar several
 *  times within this window, all writes collapse into the latest row (same
 *  id, updated percent). Without this, a single drag session produced 5-20
 *  "进度 X% → Y%" entries that obscured real audit signal in 动态.
 *
 *  The window also covers the post-drag description flow: the user drags to
 *  some value, then types a one-line note in the popover. updateProgressNote
 *  preserves the original timestamp, so the final timeline reads as
 *  "进度 0% → 28% XXXX" (one entry), matching the user's expectation that
 *  "添加描述成功后，动态中要记录 + 短时间内的进度更新要合并为一条". 60s felt
 *  too tight for users who type slowly; bumped to 5min so the burst covers
 *  a normal drag → popover → type → save round-trip comfortably. */
export const PROGRESS_MERGE_WINDOW_MS = 5 * 60_000;

interface TodoRow {
  id: string;
  title: string;
  status: TodoStatus;
  priority: Priority;
  due_at: number | null;
  body_path: string;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  parent_id: string | null;
  archived_at: number | null;
  deleted_at: number | null;
  progress: number;
  planned_for: string | null;
  selected_doc_tab: string | null;
}

function rowToTodo(row: TodoRow, tags: string[], drawingIds: string[], attachmentIds: string[]): Todo {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    bodyPath: row.body_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    tags,
    attachmentIds,
    drawingIds,
    parentId: row.parent_id,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    progress: row.progress,
    plannedFor: row.planned_for,
    selectedDocTab: row.selected_doc_tab,
  };
}

export class TodoRepo {
  constructor(
    private db: Database.Database,
    /** Hook invoked after a write that mutates the `tags` association
     *  table (create / update / batchUpdate). Receives the list of tag
     *  names that ended up attached to the just-written task(s).
     *
     *  The hook is the TagRepo's `activateUsedNames` — newly-added
     *  names get a fresh catalog row, previously retired names come
     *  back to the active management list, names still active stay
     *  unchanged. Keeping the hook optional + injected means TodoRepo
     *  has no compile-time dependency on TagRepo; the wiring lives in
     *  src/main/index.ts (the bootstrap order). */
    private onTagsAttached?: (names: readonly string[]) => void,
  ) {}

  list(filter: TodoFilter = {}): Todo[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status?.length) {
      where.push(
        `status IN (${filter.status.map(() => '?').join(',')})`,
      );
      params.push(...filter.status);
    }
    if (filter.priority?.length) {
      where.push(`priority IN (${filter.priority.map(() => '?').join(',')})`);
      params.push(...filter.priority);
    }
    if (filter.dueBefore != null) {
      where.push('due_at IS NOT NULL AND due_at <= ?');
      params.push(filter.dueBefore);
    }
    if (filter.dueAfter != null) {
      where.push('due_at IS NOT NULL AND due_at >= ?');
      params.push(filter.dueAfter);
    }
    if (filter.search) {
      where.push(
        '(title LIKE ? OR EXISTS (SELECT 1 FROM tags t WHERE t.todo_id = todos.id AND t.tag LIKE ?))',
      );
      const term = `%${filter.search}%`;
      params.push(term, term);
    }
    // SubTask filter: parentId === null = top-level only; a string id =
    // direct children of that parent. Omitting the field (or undefined)
    // returns all todos regardless of nesting — used by the AI tool
    // surface when it doesn't care about hierarchy.
    if (filter.parentId === null) {
      where.push('parent_id IS NULL');
    } else if (typeof filter.parentId === 'string') {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
    // Archive scoping. archivedOnly wins over includeArchived (a caller
    // asking for the 归档 view wants ONLY archived, regardless). Otherwise
    // the default list excludes archived tasks unless includeArchived.
    if (filter.archivedOnly) {
      where.push('archived_at IS NOT NULL');
    } else if (!filter.includeArchived) {
      where.push('archived_at IS NULL');
    }

    // Delete scoping. deletedOnly surfaces the 已删除 recovery bin;
    // otherwise deleted tasks are ALWAYS excluded — even from archivedOnly
    // — so a soft-deleted task never leaks into the 归档 view or the active
    // list. There's no includeDeleted escape hatch: the only way to see
    // deleted rows is deletedOnly.
    if (filter.deletedOnly) {
      where.push('deleted_at IS NOT NULL');
    } else {
      where.push('deleted_at IS NULL');
    }

    const sql = `SELECT * FROM todos ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
    const rows = this.db.prepare<typeof params, TodoRow>(sql).all(...params);
    return rows.map((r) =>
      rowToTodo(r, this.tagsFor(r.id), this.drawingsFor(r.id), this.attachmentsFor(r.id)),
    );
  }

  get(id: ULID): Todo | null {
    const row = this.db
      .prepare<[ULID], TodoRow>('SELECT * FROM todos WHERE id = ?')
      .get(id);
    return row
      ? rowToTodo(row, this.tagsFor(id), this.drawingsFor(id), this.attachmentsFor(id))
      : null;
  }

  create(input: TodoCreate, bodyPath = 'progress.md'): Todo {
    const id = newId();
    const now = Date.now();
    const status = input.status ?? 'next';
    const priority = input.priority ?? 'low';
    const dueAt = input.dueAt ?? null;
    const parentId = input.parentId ?? null;
    const plannedFor = input.plannedFor ?? null;

    // Validate parent exists when set. We don't enforce a "depth" limit —
    // the renderer (and the user) can nest arbitrarily deep; the data model
    // doesn't care.
    if (parentId !== null) {
      const exists = this.db.prepare('SELECT 1 FROM todos WHERE id = ?').get(parentId);
      if (!exists) throw new Error(`parent_not_found: ${parentId}`);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO todos (id, title, status, priority, due_at, body_path, created_at, updated_at, parent_id, planned_for)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, status, priority, dueAt, bodyPath, now, now, parentId, plannedFor);
      if (input.tags?.length) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO tags(todo_id, tag) VALUES (?, ?)');
        for (const t of input.tags) stmt.run(id, t);
      }
    });
    tx();

    // After the write, fold any newly-attached names into the catalog
    // (or revive a retired one) so the management list reflects reality
    // without a separate settings-page round-trip. The hook is a
    // best-effort — failure here doesn't break the create, it just
    // leaves the catalog stale until the next write.
    if (input.tags?.length && this.onTagsAttached) {
      try { this.onTagsAttached(input.tags); } catch { /* ignore */ }
    }

    return this.get(id)!;
  }

  update(id: ULID, patch: TodoPatch): Todo {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    const map: Record<string, string> = {
      title: 'title',
      status: 'status',
      priority: 'priority',
      dueAt: 'due_at',
      parentId: 'parent_id',
      archivedAt: 'archived_at',
      progress: 'progress',
      plannedFor: 'planned_for',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const col = map[k];
      if (col) {
        fields.push(`${col} = ?`);
        params.push(v as string | number | null);
      }
    }
    if (fields.length === 0 && !patch.tags) {
      return this.get(id)!;
    }

    // Always stamp updated_at on any mutation. The old schema had a
    // trg_touch_updated_at AFTER UPDATE trigger that did this, but that
    // self-UPDATE trigger was removed in the v8 migration (it corrupts the
    // FTS5 shadow tables after a content-table rebuild), so the repo owns
    // the timestamp now.
    fields.push('updated_at = ?');
    params.push(Date.now());

    // Cycle prevention: when re-parenting, refuse to set parent_id to a
    // descendant of the current todo (would create a cycle). Walking
    // descendants is O(n) but n is the size of the user's todo list, and
    // a reparent is a rare admin op — fine to do synchronously.
    if (patch.parentId !== undefined && patch.parentId !== null && patch.parentId !== id) {
      if (this.isDescendant(patch.parentId, id)) {
        throw new Error('不能将任务移动到它自己的子任务中（会形成循环）');
      }
      const exists = this.db.prepare('SELECT 1 FROM todos WHERE id = ?').get(patch.parentId);
      if (!exists) throw new Error(`parent_not_found: ${patch.parentId}`);
    }
    if (patch.parentId === id) {
      throw new Error('不能将任务设置为自己的父任务');
    }

    const tx = this.db.transaction(() => {
      // Capture the old progress before the UPDATE so we can append an audit
      // row only when the value actually changed (avoids log noise from
      // no-op patches). note is null here — the user-facing "record progress
      // with a note" path is progress.log(), which does its own transaction.
      let oldProgress: number | undefined;
      if (patch.progress !== undefined) {
        const row = this.db
          .prepare('SELECT progress FROM todos WHERE id = ?')
          .get(id) as { progress: number } | undefined;
        oldProgress = row?.progress;
      }
      if (fields.length) {
        this.db
          .prepare(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`)
          .run(...params, id);
      }
      if (patch.tags) {
        this.db.prepare('DELETE FROM tags WHERE todo_id = ?').run(id);
        const stmt = this.db.prepare('INSERT OR IGNORE INTO tags(todo_id, tag) VALUES (?, ?)');
        for (const t of patch.tags) stmt.run(id, t);
      }
      if (patch.status === 'done') {
        this.db
          .prepare('UPDATE todos SET done_at = ? WHERE id = ?')
          .run(Date.now(), id);
      } else if (patch.status !== undefined) {
        // Anything other than 'done' clears done_at.
        this.db.prepare('UPDATE todos SET done_at = NULL WHERE id = ?').run(id);
      }
      if (
        patch.progress !== undefined &&
        oldProgress !== undefined &&
        oldProgress !== patch.progress
      ) {
        this.mergeOrAppendProgress(id, patch.progress, null, Date.now());
      }
    });
    tx();
    // Mirror the create() hook — any tag names that ended up attached
    // need to be in the catalog (or revived from retired) so the
    // Settings management list stays in sync.
    if (patch.tags && this.onTagsAttached) {
      try { this.onTagsAttached(patch.tags); } catch { /* ignore */ }
    }
    return this.get(id)!;
  }

  /** Persist the task's currently-selected document tab (the renderer's
   *  composite `d:<docId>` / `g:<drawingId>` id). Deliberately a bare UPDATE
   *  — does NOT touch updated_at, does NOT log progress, does NOT broadcast.
   *  A tab click is ephemeral UI state and must not reorder the task list or
   *  trigger the audit/broadcast side-effects of update(). */
  setSelectedDocTab(todoId: ULID, tabId: string | null): void {
    this.db
      .prepare('UPDATE todos SET selected_doc_tab = ? WHERE id = ?')
      .run(tabId, todoId);
  }

  /** Burst-merge a new progress write: if the most recent log row for this
   *  todo is within PROGRESS_MERGE_WINDOW_MS and shares the same note
   *  signature (both null, or both equal strings), update that row's
   *  percent in place. Otherwise INSERT a fresh row.
   *
   *  Returns the row that ended up representing this write (the merged-into
   *  row, or the brand new one) so callers can echo the canonical id/
   *  timestamp back to the renderer without an extra SELECT. */
  private mergeOrAppendProgress(
    todoId: ULID,
    percent: number,
    note: string | null,
    now: number,
  ): ProgressLogEntry {
    const latest = this.db
      .prepare<
        [ULID, number],
        { id: string; percent: number; note: string | null; created_at: number }
      >(
        'SELECT id, percent, note, created_at FROM progress_log WHERE todo_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(todoId, now - PROGRESS_MERGE_WINDOW_MS);
    // Note signature must match exactly: a row with a real note ends the
    // burst (the user explicitly recorded something — don't silently fold
    // later no-note writes into it). NULLs match only NULLs.
    const noteMatches =
      latest !== undefined &&
      ((latest.note === null && note === null) ||
        (latest.note !== null && note !== null && latest.note === note));
    if (latest && noteMatches) {
      this.db
        .prepare('UPDATE progress_log SET percent = ? WHERE id = ?')
        .run(percent, latest.id);
      return {
        id: latest.id,
        todoId,
        percent,
        note: latest.note,
        createdAt: latest.created_at,
      };
    }
    const id = newId();
    this.db
      .prepare(
        'INSERT INTO progress_log (id, todo_id, percent, note, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, todoId, percent, note, now);
    return { id, todoId, percent, note, createdAt: now };
  }

  /** Record a progress entry: sets the todos.progress column AND appends a
   *  progress_log row with the user's (optional) one-line note. This is the
   *  user-facing "录入进展" path. It does NOT go through update() (which
   *  would append a second, note-less log row) — it owns its own transaction.
   *  percent is clamped to [0, 100] and rounded. Returns the entry that
   *  ended up representing this write (may be a previously-existing row we
   *  burst-merged into) plus the refreshed todo so the renderer can update
   *  both at once. */
  logProgress(
    todoId: ULID,
    percent: number,
    note?: string,
  ): { entry: ProgressLogEntry; todo: Todo } {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const now = Date.now();
    const normalizedNote = note?.trim() ? note.trim() : null;
    const tx = this.db.transaction(() => {
      this.mergeOrAppendProgress(todoId, clamped, normalizedNote, now);
      this.db
        .prepare('UPDATE todos SET progress = ?, updated_at = ? WHERE id = ?')
        .run(clamped, now, todoId);
    });
    tx();
    // Re-read the canonical row (post-merge) so the id/timestamp we hand
    // back match what the next listProgress() call will return.
    const canonical = this.db
      .prepare<
        [ULID],
        { id: string; percent: number; note: string | null; created_at: number }
      >(
        'SELECT id, percent, note, created_at FROM progress_log WHERE todo_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(todoId);
    const finalEntry: ProgressLogEntry = canonical
      ? {
          id: canonical.id,
          todoId,
          percent: canonical.percent,
          note: canonical.note,
          createdAt: canonical.created_at,
        }
      : { id: 'unknown', todoId, percent: clamped, note: normalizedNote, createdAt: now };
    return { entry: finalEntry, todo: this.get(todoId)! };
  }

  /** Audit timeline for a task, newest-first. Used by the detail editor's
   *  collapsible progress history. */
  listProgress(todoId: ULID): ProgressLogEntry[] {
    const rows = this.db
      .prepare<
        [ULID],
        { id: string; todo_id: string; percent: number; note: string | null; created_at: number }
      >(
        'SELECT id, todo_id, percent, note, created_at FROM progress_log WHERE todo_id = ? ORDER BY created_at DESC',
      )
      .all(todoId);
    return rows.map((r) => ({
      id: r.id,
      todoId: r.todo_id,
      percent: r.percent,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  /** Update the note on an existing progress_log entry (e.g. the user clicked
   *  the latest progress description to edit it). Only the note changes; the
   *  percent + timestamp are preserved. Returns the updated entry, or null if
   *  the entry id doesn't exist. */
  updateProgressNote(entryId: string, note: string | null): ProgressLogEntry | null {
    const row = this.db
      .prepare<
        [string],
        { id: string; todo_id: string; percent: number; note: string | null; created_at: number }
      >('SELECT id, todo_id, percent, note, created_at FROM progress_log WHERE id = ?')
      .get(entryId);
    if (!row) return null;
    const trimmed = note?.trim() || null;
    this.db.prepare('UPDATE progress_log SET note = ? WHERE id = ?').run(trimmed, entryId);
    return {
      id: row.id,
      todoId: row.todo_id,
      percent: row.percent,
      note: trimmed,
      createdAt: row.created_at,
    };
  }

  /** Walk the parent_id chain from `candidate` to see if it eventually
   *  reaches `target` (i.e. candidate is a descendant of target). Used
   *  to reject cyclic re-parenting in update(). */
  private isDescendant(candidate: ULID, target: ULID): boolean {
    let cur: string | null = candidate;
    const seen = new Set<string>();
    while (cur !== null) {
      if (cur === target) return true;
      if (seen.has(cur)) return false; // defensive against pre-existing cycles
      seen.add(cur);
      const row = this.db
        .prepare<[string], { parent_id: string | null }>('SELECT parent_id FROM todos WHERE id = ?')
        .get(cur);
      cur = row?.parent_id ?? null;
    }
    return false;
  }

  /** Soft-delete a task and its ENTIRE subtree. Stamps deleted_at (epoch ms)
   *  on the task + every descendant via a recursive CTE, so deleting a
   *  parent removes the whole branch from the active list without losing
   *  any row. The row + markdown + drawings survive — restore() clears it.
   *  Idempotent: re-deleting an already-deleted subtree just refreshes the
   *  timestamp. FK ON DELETE SET NULL never fires (we UPDATE, not DELETE). */
  delete(id: ULID): void {
    const now = Date.now();
    this.db
      .prepare(
        `WITH subtree(id) AS (
           SELECT id FROM todos WHERE id = ?
           UNION ALL
           SELECT t.id FROM todos t JOIN subtree s ON t.parent_id = s.id
         )
         UPDATE todos SET deleted_at = ?, updated_at = ?
         WHERE id IN (SELECT id FROM subtree)`,
      )
      .run(id, now, now);
  }

  /** Restore a soft-deleted task and its ENTIRE subtree — the inverse of
   *  delete(). Clears deleted_at on the task + every descendant so the whole
   *  branch returns to the active list. If the task isn't deleted this is a
   *  no-op (the UPDATE matches nothing harmful). */
  restore(id: ULID): void {
    const now = Date.now();
    this.db
      .prepare(
        `WITH subtree(id) AS (
           SELECT id FROM todos WHERE id = ?
           UNION ALL
           SELECT t.id FROM todos t JOIN subtree s ON t.parent_id = s.id
         )
         UPDATE todos SET deleted_at = NULL, updated_at = ?
         WHERE id IN (SELECT id FROM subtree)`,
      )
      .run(id, now);
  }

  /** Auto-archive sweep: mark every `done` task whose done_at is older than
   *  `thresholdMs` (and not already archived) as archived. Returns the count
   *  of newly archived tasks. Called at boot (and periodically) from
   *  src/main/index.ts using the configured archiveAfterDays setting.
   *  Idempotent — re-running only touches newly-eligible tasks. */
  archiveStale(thresholdMs: number): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE todos
         SET archived_at = ?
         WHERE status = 'done'
           AND done_at IS NOT NULL
           AND done_at < ?
           AND archived_at IS NULL`,
      )
      .run(now, thresholdMs);
    return res.changes;
  }

  /** 「今日待办」的数量 —— 专门给 plan-reminder 用。精确匹配 planned_for =
   *  todayKey（'YYYY-MM-DD' 本地日期串），排除已归档 / 已删除。等价 SQL
   *  count，比拉全表 + JS 过滤更快，也跟 idx_todos_planned_for 索引贴齐。 */
  countPlannedFor(todayKey: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM todos
         WHERE planned_for = ?
           AND deleted_at IS NULL
           AND archived_at IS NULL`,
      )
      .get(todayKey);
    return row?.c ?? 0;
  }

  /** 活跃任务总数（未删除、未归档）。给 plan-reminder 用：用户库里一个任务都
   *  没有时，"今天安排些什么？"的提醒没有意义，直接抑制。 */
  countActive(): number {
    const row = this.db
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM todos
         WHERE deleted_at IS NULL
           AND archived_at IS NULL`,
      )
      .get();
    return row?.c ?? 0;
  }

  batchUpdate(ids: ULID[], patch: TodoPatch): Todo[] {
    const tx = this.db.transaction(() => {
      for (const id of ids) this.update(id, patch);
    });
    tx();
    return ids.map((id) => this.get(id)).filter((t): t is Todo => !!t);
  }

  search(query: string, limit = 50): SearchHit[] {
    const term = query.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim();
    if (!term) return [];
    const ftsQuery = term
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `${w}*`)
      .join(' OR ');
    if (!ftsQuery) return [];

    type Row = {
      id: string;
      title: string;
      status: TodoStatus;
      priority: Priority;
      due_at: number | null;
      body_path: string;
      created_at: number;
      updated_at: number;
      done_at: number | null;
      parent_id: string | null;
      archived_at: number | null;
      deleted_at: number | null;
      progress: number;
      planned_for: string | null;
      selected_doc_tab: string | null;
      snippet: string;
      score: number;
    };

    const rows = this.db
      .prepare<[string, number], Row>(
        `SELECT t.*, snippet(todos_fts, 1, '<mark>', '</mark>', '…', 12) as snippet,
                bm25(todos_fts) as score
         FROM todos_fts f
         JOIN todos t ON t.rowid = f.rowid
         WHERE todos_fts MATCH ? AND t.deleted_at IS NULL
         ORDER BY score
         LIMIT ?`,
      )
      .all(ftsQuery, limit);

    return rows.map((r) => ({
      todo: rowToTodo(r, this.tagsFor(r.id), this.drawingsFor(r.id), this.attachmentsFor(r.id)),
      snippet: r.snippet,
      score: r.score,
    }));
  }

  stats(windowDays = 7): TodoStats {
    // Stats describe LIVE work only — exclude soft-deleted rows so a
    // deleted task doesn't inflate totals or the done count.
    const total = (
      this.db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM todos WHERE deleted_at IS NULL').get()
    )?.c ?? 0;
    const byStatus: Record<TodoStatus, number> = {
      next: 0,
      doing: 0,
      done: 0,
      cancelled: 0,
      blocked: 0,
    };
    const statusRows = this.db
      .prepare<[], { status: TodoStatus; c: number }>(
        'SELECT status, COUNT(*) as c FROM todos WHERE deleted_at IS NULL GROUP BY status',
      )
      .all();
    for (const r of statusRows) byStatus[r.status] = r.c;

    const windowStart = Date.now() - windowDays * 24 * 3600 * 1000;
    const completedRecent = (
      this.db
        .prepare<[string, number], { c: number }>(
          'SELECT COUNT(*) as c FROM todos WHERE status = ? AND done_at >= ? AND deleted_at IS NULL',
        )
        .get('done', windowStart)
    )?.c ?? 0;
    const completionRate7d = byStatus.done
      ? completedRecent / Math.max(byStatus.done, 1)
      : 0;

    const avgLatency = (
      this.db
        .prepare<[string], { avg: number | null }>(
          'SELECT AVG(done_at - created_at) as avg FROM todos WHERE status = ? AND done_at IS NOT NULL AND deleted_at IS NULL',
        )
        .get('done')
    )?.avg ?? 0;

    return {
      total,
      byStatus,
      completionRate7d,
      avgDoneLatencyMs: avgLatency ?? 0,
    };
  }

  private tagsFor(id: ULID): string[] {
    return this.db
      .prepare<[ULID], { tag: string }>('SELECT tag FROM tags WHERE todo_id = ?')
      .all(id)
      .map((r) => r.tag);
  }

  private drawingsFor(id: ULID): ULID[] {
    return this.db
      .prepare<[ULID], { id: string }>('SELECT id FROM drawings WHERE todo_id = ?')
      .all(id)
      .map((r) => r.id);
  }

  private attachmentsFor(id: ULID): ULID[] {
    return this.db
      .prepare<[ULID], { id: string }>('SELECT id FROM inbox_attachments WHERE todo_id = ?')
      .all(id)
      .map((r) => r.id);
  }
}
