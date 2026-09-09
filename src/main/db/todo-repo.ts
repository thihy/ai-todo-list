// TodoRepo: thin layer over the todos table + tags + drawing aggregation + FTS search.

import type Database from 'better-sqlite3';
import { newId } from './schema';
import type {
  Priority,
  SearchHit,
  Todo,
  TodoCreate,
  TodoFilter,
  TodoPatch,
  TodoStats,
  TodoStatus,
  ULID,
} from '../../shared/todo-types';

interface TodoRow {
  id: string;
  title: string;
  status: TodoStatus;
  priority: Priority;
  project: string | null;
  due_at: number | null;
  body_path: string;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  parent_id: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

function rowToTodo(row: TodoRow, tags: string[], drawingIds: string[]): Todo {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    project: row.project,
    dueAt: row.due_at,
    bodyPath: row.body_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    tags,
    attachmentIds: [],
    drawingIds,
    parentId: row.parent_id,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
  };
}

export class TodoRepo {
  constructor(private db: Database.Database) {}

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
    if (filter.project?.length) {
      where.push(`project IN (${filter.project.map(() => '?').join(',')})`);
      params.push(...filter.project);
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
    return rows.map((r) => rowToTodo(r, this.tagsFor(r.id), this.drawingsFor(r.id)));
  }

  get(id: ULID): Todo | null {
    const row = this.db
      .prepare<[ULID], TodoRow>('SELECT * FROM todos WHERE id = ?')
      .get(id);
    return row ? rowToTodo(row, this.tagsFor(id), this.drawingsFor(id)) : null;
  }

  create(input: TodoCreate, bodyPath: string): Todo {
    const id = newId();
    const now = Date.now();
    const status = input.status ?? 'next';
    const priority = input.priority ?? 'none';
    const project = input.project ?? null;
    const dueAt = input.dueAt ?? null;
    const parentId = input.parentId ?? null;

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
          `INSERT INTO todos (id, title, status, priority, project, due_at, body_path, created_at, updated_at, parent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, status, priority, project, dueAt, bodyPath, now, now, parentId);
      if (input.tags?.length) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO tags(todo_id, tag) VALUES (?, ?)');
        for (const t of input.tags) stmt.run(id, t);
      }
    });
    tx();

    return this.get(id)!;
  }

  update(id: ULID, patch: TodoPatch): Todo {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    const map: Record<string, string> = {
      title: 'title',
      status: 'status',
      priority: 'priority',
      project: 'project',
      dueAt: 'due_at',
      parentId: 'parent_id',
      archivedAt: 'archived_at',
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
    });
    tx();
    return this.get(id)!;
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
      project: string | null;
      due_at: number | null;
      body_path: string;
      created_at: number;
      updated_at: number;
      done_at: number | null;
      parent_id: string | null;
      archived_at: number | null;
      deleted_at: number | null;
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
      todo: rowToTodo(r, this.tagsFor(r.id), this.drawingsFor(r.id)),
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
}