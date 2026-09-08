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
  group_id: string | null;
  parent_id: string | null;
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
    groupId: row.group_id,
    parentId: row.parent_id,
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
    if (filter.groupIds?.length) {
      where.push(`group_id IN (${filter.groupIds.map(() => '?').join(',')})`);
      params.push(...filter.groupIds);
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
    const status = input.status ?? 'inbox';
    const priority = input.priority ?? 'none';
    const project = input.project ?? null;
    const dueAt = input.dueAt ?? null;
    const groupId = input.groupId ?? null;
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
          `INSERT INTO todos (id, title, status, priority, project, due_at, body_path, created_at, updated_at, group_id, parent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, status, priority, project, dueAt, bodyPath, now, now, groupId, parentId);
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
      groupId: 'group_id',
      parentId: 'parent_id',
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

  delete(id: ULID): void {
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
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
      group_id: string | null;
      snippet: string;
      score: number;
    };

    const rows = this.db
      .prepare<[string, number], Row>(
        `SELECT t.*, snippet(todos_fts, 1, '<mark>', '</mark>', '…', 12) as snippet,
                bm25(todos_fts) as score
         FROM todos_fts f
         JOIN todos t ON t.rowid = f.rowid
         WHERE todos_fts MATCH ?
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
    const total = (
      this.db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM todos').get()
    )?.c ?? 0;
    const byStatus: Record<TodoStatus, number> = {
      inbox: 0,
      next: 0,
      doing: 0,
      blocked: 0,
      done: 0,
    };
    const statusRows = this.db
      .prepare<[], { status: TodoStatus; c: number }>(
        'SELECT status, COUNT(*) as c FROM todos GROUP BY status',
      )
      .all();
    for (const r of statusRows) byStatus[r.status] = r.c;

    const windowStart = Date.now() - windowDays * 24 * 3600 * 1000;
    const completedRecent = (
      this.db
        .prepare<[string, number], { c: number }>(
          'SELECT COUNT(*) as c FROM todos WHERE status = ? AND done_at >= ?',
        )
        .get('done', windowStart)
    )?.c ?? 0;
    const completionRate7d = byStatus.done
      ? completedRecent / Math.max(byStatus.done, 1)
      : 0;

    const avgLatency = (
      this.db
        .prepare<[string], { avg: number | null }>(
          'SELECT AVG(done_at - created_at) as avg FROM todos WHERE status = ? AND done_at IS NOT NULL',
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