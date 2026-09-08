// GroupRepo: hand-edited directory tree. Groups are folders; tasks are files.
// Distinct from `project` / tags. parentId gives the tree shape; sortOrder
// orders siblings. Deleting a group un-files its tasks (group_id → null) and
// cascades to descendants.

import type Database from 'better-sqlite3';
import { newId } from './schema';
import type { Group, GroupPatch, ULID } from '../../shared/todo-types';

interface GroupRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
}

function rowToGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export class GroupRepo {
  constructor(private db: Database.Database) {}

  /** All groups, ordered for a stable tree (parent first, then sortOrder). */
  list(): Group[] {
    const rows = this.db
      .prepare<[], GroupRow>(
        `SELECT * FROM groups ORDER BY COALESCE(parent_id, ''), sort_order ASC, created_at ASC`,
      )
      .all();
    return rows.map(rowToGroup);
  }

  create(name: string, parentId: ULID | null = null): Group {
    const id = newId();
    const now = Date.now();
    const sortOrder = this.nextSortOrder(parentId);
    this.db
      .prepare(
        `INSERT INTO groups (id, name, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, parentId, sortOrder, now);
    return this.get(id)!;
  }

  update(id: ULID, patch: GroupPatch): Group {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name);
    }
    if (patch.parentId !== undefined) {
      // Prevent making a group its own descendant.
      if (patch.parentId !== null && this.isDescendant(patch.parentId, id)) {
        throw new Error('不能将分组移动到它自己的子目录中');
      }
      fields.push('parent_id = ?');
      params.push(patch.parentId);
    }
    if (patch.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      params.push(patch.sortOrder);
    }
    if (fields.length > 0) {
      this.db
        .prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return this.get(id)!;
  }

  /**
   * Delete a group (and its subtree). Tasks filed under any deleted group are
   * un-filed (group_id set to null) rather than destroyed — directories vanish,
   * files remain.
   */
  delete(id: ULID): void {
    const ids = this.descendantIds(id);
    const tx = this.db.transaction(() => {
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(`UPDATE todos SET group_id = NULL WHERE group_id IN (${placeholders})`)
        .run(...ids);
      this.db.prepare(`DELETE FROM groups WHERE id IN (${placeholders})`).run(...ids);
    });
    tx();
  }

  /** Count of tasks per group id, plus null key for unfiled. */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare<[], { group_id: string | null; c: number }>(
        `SELECT group_id, COUNT(*) as c FROM todos GROUP BY group_id`,
      )
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.group_id ?? '__unfiled__'] = r.c;
    return out;
  }

  get(id: ULID): Group | null {
    const row = this.db.prepare<[ULID], GroupRow>('SELECT * FROM groups WHERE id = ?').get(id);
    return row ? rowToGroup(row) : null;
  }

  private nextSortOrder(parentId: ULID | null): number {
    const row = this.db
      .prepare<[string | null], { m: number | null }>(
        `SELECT MAX(sort_order) as m FROM groups WHERE parent_id IS ?`,
      )
      .get(parentId ?? null);
    return (row?.m ?? -1) + 1;
  }

  /** All ids in the subtree rooted at id, INCLUDING id itself. */
  private descendantIds(id: ULID): ULID[] {
    const rows = this.db
      .prepare<[ULID], { id: string }>(
        `WITH RECURSIVE descend(id) AS (
           SELECT id FROM groups WHERE id = ?
           UNION ALL
           SELECT g.id FROM groups g JOIN descend d ON g.parent_id = d.id
         )
         SELECT id FROM descend`,
      )
      .all(id);
    return rows.map((r) => r.id);
  }

  /** True if `ancestor` is id or lies below id in the tree. */
  private isDescendant(ancestor: ULID, id: ULID): boolean {
    return this.descendantIds(id).includes(ancestor);
  }
}
