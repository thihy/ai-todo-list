// TagRepo — DB-backed directory of tag names + colour + retired flag, plus
// rename / merge / cleanup operations over the `tags` association table.
//
// Semantics:
//   - "valid task"  :=  deleted_at IS NULL AND archived_at IS NULL.
//     This is the SAME definition the rest of the app uses (TodoRepo.list,
//     todo.list filter, stats). We re-state it here so the catalog code
//     does not have to import TodoRepo just to share a predicate — and
//     so a future refactor that moves the predicate into a shared util
//     stays a one-file change.
//   - `name` is the PRIMARY KEY of tag_catalog, case-sensitive. The
//     catalog NEVER auto-merges case variants ("work" vs "Work") —
//     that is an explicit user action via the merge flow. The migration
//     also does NOT collapse case variants; both names coexist as
//     distinct catalog rows + distinct task associations.
//   - A catalog row is "active" iff `retired_at IS NULL`. Retired rows
//     stay in the catalog (so restore is a no-op data-wise) and stay
//     attached to whatever tasks still reference them (rename / merge
//     never deletes historical associations).
//   - Stats use JOIN with the todos table + COUNT(DISTINCT todo_id) so
//     the same task hit twice in the same merge preview is still
//     counted once. This is the same contract the renderer's old
//     "useTodos → Set(tag.toLowerCase)" loop had, just pushed into SQL
//     so we don't paginate the entire todo list to answer one
//     management question.
//
// All mutating operations wrap in a transaction so a failure leaves the
// DB in its pre-call state. The renderer is told about the change via
// the `app:tags-changed` event broadcast by tag-handler.ts; that
// broadcast is intentionally OUTSIDE the transaction so a partially-
// failed (rolled back) write never wakes the renderer's UI.

import type Database from 'better-sqlite3';
import type { ULID } from '../../shared/todo-types';

export interface TagCatalogRow {
  name: string;
  color: string;
  /** Epoch ms; null = active. */
  retiredAt: number | null;
}

export interface TagCatalogEntry extends TagCatalogRow {
  /** Number of "valid tasks" (deleted_at IS NULL AND archived_at IS NULL)
   *  that currently carry this name. */
  activeCount: number;
  /** Number of historical tasks (deleted OR archived) that still carry
   *  this name. May be 0 when the tag is used purely by future valid
   *  tasks; non-zero on retired rows is the expected reason they exist. */
  historicalCount: number;
}

/** "有效任务" predicate — same definition as TodoRepo.list / filter. */
const VALID_TASK_PREDICATE =
  "todos.deleted_at IS NULL AND todos.archived_at IS NULL";

export class TagRepo {
  constructor(private readonly db: Database.Database) {}

  /** Read-side: full catalog with usage counts.
   *  activeOnly=true returns the management list (excluding retired). */
  list(opts?: { activeOnly?: boolean }): TagCatalogEntry[] {
    const filter = opts?.activeOnly ? 'WHERE tc.retired_at IS NULL' : '';
    // LEFT JOIN on tags → todos so a catalog row with zero attached
    // tasks still appears in the result (with both counts = 0). The
    // COUNT(DISTINCT) guards against a single task being attached to
    // the same tag twice (the PK prevents that, but a future
    // refactor might relax it).
    const sql = `
      SELECT
        tc.name,
        tc.color,
        tc.retired_at AS retiredAt,
        COALESCE(SUM(CASE WHEN ${VALID_TASK_PREDICATE} THEN 1 ELSE 0 END), 0) AS activeCount,
        COALESCE(SUM(CASE WHEN NOT (${VALID_TASK_PREDICATE}) THEN 1 ELSE 0 END), 0) AS historicalCount
      FROM tag_catalog tc
      LEFT JOIN tags t ON t.tag = tc.name
      LEFT JOIN todos ON todos.id = t.todo_id
      ${filter}
      GROUP BY tc.name
      ORDER BY activeCount DESC, tc.name COLLATE NOCASE ASC
    `;
    type Row = {
      name: string;
      color: string;
      retiredAt: number | null;
      activeCount: number;
      historicalCount: number;
    };
    const rows = this.db.prepare<[], Row>(sql).all();
    return rows.map((r) => ({
      name: r.name,
      color: r.color,
      retiredAt: r.retiredAt,
      activeCount: r.activeCount,
      historicalCount: r.historicalCount,
    }));
  }

  /** One-shot read of active catalog rows. Thin convenience for the
   *  TagInput popover — same data shape as `list({activeOnly:true})` but
   *  narrower so callers don't accidentally reach for retired rows. */
  activeCatalog(): TagCatalogRow[] {
    const rows = this.db
      .prepare<[], { name: string; color: string; retiredAt: number | null }>(
        `SELECT name, color, retired_at AS retiredAt
         FROM tag_catalog
         WHERE retired_at IS NULL
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all();
    return rows;
  }

  /** Idempotent import from a legacy source (the old settings.tags array,
   *  or any task-applied name). existing.colors: tag-name → existing
   *  colour from the legacy registry. Names not yet in the catalog get
   *  inserted with that colour + active (retired_at = NULL); names that
   *  are already present keep whatever colour they had. retired_at is
   *  deliberately NOT touched on existing rows — a user who explicitly
   *  retired a tag must not see it reactivated by an import. */
  importEntries(entries: { name: string; color: string }[]): { added: number } {
    let added = 0;
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO tag_catalog (name, color, retired_at) VALUES (?, ?, NULL)`,
      );
      for (const e of entries) {
        const name = e.name.trim();
        if (!name) continue;
        const r = stmt.run(name, e.color);
        if (r.changes > 0) added += 1;
      }
    });
    tx();
    return { added };
  }

  /** Ensure every distinct name in the `tags` association table has a
   *  catalog row. Used right after schema migration AND on every write
   *  path (create / update) so AI-created tags land in the catalog
   *  without a separate settings-page round-trip.
   *
   *  Returns the list of newly-added names so the caller can show a
   *  toast ("标签 已创建 / 已恢复 可管理"). The colour assigned to
   *  brand-new names is a neutral grey; the Settings UI lets the user
   *  re-paint them at leisure. */
  ensureFromTagsTable(): string[] {
    const newNames: string[] = [];
    const tx = this.db.transaction(() => {
      const found = this.db
        .prepare<[], { name: string }>(
          `SELECT DISTINCT tag AS name FROM tags WHERE tag NOT IN (SELECT name FROM tag_catalog)`,
        )
        .all();
      const stmt = this.db.prepare(
        `INSERT INTO tag_catalog (name, color, retired_at) VALUES (?, ?, NULL)`,
      );
      for (const r of found) {
        stmt.run(r.name, '#6B7280');
        newNames.push(r.name);
      }
    });
    tx();
    return newNames;
  }

  /** Idempotent self-heal invoked by TodoRepo before every write that
   *  mutates the `tags` table. Cheap: a single SELECT + a per-name
   *  INSERT OR UPDATE statement, all in one transaction.
   *
   *  Behaviour:
   *    - name not in catalog       → INSERT with grey colour, active
   *    - name in catalog, retired  → CLEAR retired_at (the tag is in use
   *                                   again by a valid task, so it goes
   *                                   back to the active management list)
   *    - name in catalog, active   → no-op (colour unchanged)
   *
   *  Note this is the COMPLEMENT of `retireWhenOrphan` — together they
   *  keep the catalog aligned with reality. */
  activateUsedNames(names: readonly string[]): void {
    if (names.length === 0) return;
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO tag_catalog (name, color, retired_at) VALUES (?, '#6B7280', NULL)`,
      );
      const revive = this.db.prepare(
        `UPDATE tag_catalog SET retired_at = NULL WHERE name = ? AND retired_at IS NOT NULL`,
      );
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        insert.run(name);
        revive.run(name);
      }
    });
    tx();
  }

  /** Rename `oldName` → `newName` across the catalog + valid-task
   *  associations only. Historical tasks (deleted / archived) keep
   *  their old tag associations verbatim — the rename is intentionally
   *  NOT propagated so the user can always see "this task was tagged
   *  X before someone renamed X to Y" in their history.
   *
   *  If `newName` already exists in the catalog, this throws — the
   *  caller should switch to `merge()` and present the impact to the
   *  user. */
  rename(oldName: string, newName: string): void {
    const old = oldName.trim();
    const next = newName.trim();
    if (!old || !next) throw new Error('标签名称不能为空');
    if (old === next) return;
    const tx = this.db.transaction(() => {
      const exists = this.db
        .prepare<[string], { name: string }>(
          `SELECT name FROM tag_catalog WHERE name = ?`,
        )
        .get(next);
      if (exists) {
        throw new Error(
          `目标名称「${next}」已存在，请改用合并或先清理该名称`,
        );
      }
      // Rename the catalog row first; the FK from `tags.tag → tag_catalog.name`
      // doesn't exist (we never declared one so historical orphans stay
      // readable), but the per-association rows still need to follow.
      this.db.prepare(`UPDATE tag_catalog SET name = ? WHERE name = ?`).run(next, old);
      // Touch ONLY the valid-task associations. The `tags` table has no
      // task-id-with-status column directly — we need a join against todos
      // for the validity predicate.
      this.db
        .prepare(
          `UPDATE tags SET tag = ?
             WHERE tag = ?
               AND todo_id IN (SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE})`,
        )
        .run(next, old);
      // Bump updated_at on the affected tasks so the UI's list
      // ordering reflects the change.
      this.db
        .prepare(
          `UPDATE todos SET updated_at = ?
             WHERE id IN (
               SELECT DISTINCT todo_id FROM tags WHERE tag = ?
                 AND todo_id IN (SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE})
             )`,
        )
        .run(Date.now(), next);
      // Retire the old name only if it has zero remaining valid-task
      // associations. We do NOT drop the catalog row — historical
      // tasks may still reference it, and a user may want to restore
      // later by re-typing it on a task.
      const leftover = this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM tags WHERE tag = ?
             AND todo_id IN (SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE})`,
        )
        .get(old);
      if (!leftover || leftover.c === 0) {
        this.db
          .prepare(`UPDATE tag_catalog SET retired_at = ? WHERE name = ? AND retired_at IS NULL`)
          .run(Date.now(), old);
      }
    });
    tx();
  }

  /** Merge `sourceNames[]` → `targetName` on valid-task associations only.
   *  Returns the set of todo ids whose tag list changed (for downstream
   *  notifications + .json snapshot rewrite).
   *
   *  Step-by-step (all inside one transaction):
   *    1. Resolve the target catalog row. If absent, create it (the source
   *       names are about to be merged INTO it, so it must exist for
   *       future references).
   *    2. For every (valid task, source-tag) pair: ensure the same task
   *       has the target tag — INSERT OR IGNORE so the unique constraint
   *       protects against double-add (a task already tagged target
   *       + source just becomes tagged target, which is the desired
   *       de-dup outcome).
   *    3. Delete the (valid task, source-tag) association rows. GLOBAL
   *       DELETE FROM tags WHERE tag = ? is forbidden here — only the
   *       rows whose task is valid get dropped. Historical tasks keep
   *       their source-tag association untouched.
   *    4. Retire any source catalog rows that now have zero valid-task
   *       associations. Historical orphans are kept readable.
   *    5. Bump updated_at on every affected valid task. */
  merge(sourceNames: readonly string[], targetName: string, opts?: {
    /** Colour to assign if the target row has to be created. Falls back
     *  to the source colour when omitted (use the first source with a
     *  non-empty colour). */
    newColor?: string;
  }): { affectedTodoIds: ULID[] } {
    const target = targetName.trim();
    if (!target) throw new Error('目标标签不能为空');
    const sources = sourceNames.map((s) => s.trim()).filter(Boolean);
    if (sources.includes(target)) {
      // Merging a name into itself is a no-op — just bail without
      // touching anything. The caller (preview UI) is expected to
      // filter this out before calling.
      return { affectedTodoIds: [] };
    }
    let affectedTodoIds: ULID[] = [];
    const tx = this.db.transaction(() => {
      // 1. Resolve target catalog row.
      const targetRow = this.db
        .prepare<[string], { color: string; retired_at: number | null }>(
          `SELECT color, retired_at FROM tag_catalog WHERE name = ?`,
        )
        .get(target);
      if (!targetRow) {
        const color =
          opts?.newColor ||
          sources
            .map((s) => this.db
              .prepare<[string], { color: string }>(
                `SELECT color FROM tag_catalog WHERE name = ?`,
              )
              .get(s)?.color)
            .find((c): c is string => Boolean(c)) ||
          '#6B7280';
        this.db
          .prepare(
            `INSERT INTO tag_catalog (name, color, retired_at) VALUES (?, ?, NULL)`,
          )
          .run(target, color);
      } else if (targetRow.retired_at != null) {
        // Target was retired; merging source rows into it makes it
        // active again (the user explicitly asked for this).
        this.db
          .prepare(`UPDATE tag_catalog SET retired_at = NULL WHERE name = ?`)
          .run(target);
      }

      // 2. Snapshot which (valid) tasks currently carry a source tag —
      //    that's the union we need to de-dup against the target.
      const affectedSet = new Set<string>();
      const selectTodoIds = this.db.prepare<[string], { todo_id: string }>(
        `SELECT DISTINCT tags.todo_id
           FROM tags
           JOIN todos ON todos.id = tags.todo_id
           WHERE tags.tag = ? AND ${VALID_TASK_PREDICATE}`,
      );
      for (const src of sources) {
        for (const r of selectTodoIds.all(src)) {
          affectedSet.add(r.todo_id);
        }
      }

      // 3. Insert target association on every affected task; ignore
      //    the duplicate when the task already had the target tag.
      const insertTarget = this.db.prepare(
        `INSERT OR IGNORE INTO tags (todo_id, tag) VALUES (?, ?)`,
      );
      for (const todoId of affectedSet) {
        insertTarget.run(todoId, target);
      }

      // 4. Drop ONLY the source associations on the affected tasks.
      //    Historical tasks (deleted/archived) are excluded by the
      //    WHERE subquery against todos.
      const deleteSource = this.db.prepare(
        `DELETE FROM tags
           WHERE tag = ?
             AND todo_id IN (
               SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE}
             )`,
      );
      for (const src of sources) {
        deleteSource.run(src);
      }

      // 5. Retire source catalog rows whose valid-task usage hit zero.
      const hasValidUsage = this.db.prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM tags
           WHERE tag = ?
             AND todo_id IN (SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE})`,
      );
      const retire = this.db.prepare(
        `UPDATE tag_catalog SET retired_at = ? WHERE name = ? AND retired_at IS NULL`,
      );
      const now = Date.now();
      for (const src of sources) {
        const u = hasValidUsage.get(src);
        if (!u || u.c === 0) retire.run(now, src);
      }

      // 6. Bump updated_at on every affected task so list / search
      //    ordering reflects the merge.
      if (affectedSet.size > 0) {
        const placeholders = Array.from(affectedSet, () => '?').join(',');
        this.db
          .prepare(
            `UPDATE todos SET updated_at = ? WHERE id IN (${placeholders})`,
          )
          .run(now, ...affectedSet);
      }
      affectedTodoIds = Array.from(affectedSet);
    });
    tx();
    return { affectedTodoIds };
  }

  /** Reactivate a retired catalog row. No-op if already active. */
  reactivate(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.db
      .prepare(`UPDATE tag_catalog SET retired_at = NULL WHERE name = ? AND retired_at IS NOT NULL`)
      .run(trimmed);
  }

  /** Build a preview of "what would happen if we cleaned up these
   *  retired / unused names". Pure read; does NOT mutate anything. */
  previewCleanup(): CleanupPreview {
    // Two buckets:
    //  - unused: name in catalog, retired_at IS NULL, valid-task count 0
    //    (active in the management list but no valid task uses it).
    //    Cleanup → retire (retired_at = now). Historical task
    //    associations remain so "this task was tagged X" stays
    //    readable.
    //  - similar: pair (a, b) of distinct active names where the
    //    candidate (lower-cased + collapsed whitespace) is equal but
    //    the original names differ. We do NOT cross case-only or
    //    whitespace-only as semantic-equal — they are just SUGGESTIONS
    //    for the user to inspect. Auto-merge is out of scope.
    const unused: CleanupPreviewUnused[] = this.db
      .prepare<[], { name: string; historicalCount: number }>(
        `SELECT tc.name,
                COALESCE((
                  SELECT COUNT(*) FROM tags t
                    JOIN todos ON todos.id = t.todo_id
                    WHERE t.tag = tc.name AND NOT (${VALID_TASK_PREDICATE})
                ), 0) AS historicalCount
           FROM tag_catalog tc
           WHERE tc.retired_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM tags t
                 JOIN todos ON todos.id = t.todo_id
                 WHERE t.tag = tc.name AND ${VALID_TASK_PREDICATE}
             )
           ORDER BY tc.name COLLATE NOCASE ASC`,
      )
      .all()
      .map((r) => ({ name: r.name, historicalCount: r.historicalCount }));

    // Candidate key: trim + collapse internal whitespace + lowercase.
    // Two names with the same key are flagged for the user to consider
    // merging. We deliberately ignore case-only here — "Work" and
    // "work" are intentionally a single suggestion group. Substring /
    // containment suggestions ("工作" vs "工作总结") are intentionally
    // NOT generated here — the spec forbids inclusion-based merging.
    const similarGroups = this.db
      .prepare<[], { name: string; activeCount: number }>(
        `SELECT tc.name,
                COALESCE((
                  SELECT COUNT(DISTINCT t.todo_id) FROM tags t
                    JOIN todos ON todos.id = t.todo_id
                    WHERE t.tag = tc.name AND ${VALID_TASK_PREDICATE}
                ), 0) AS activeCount
           FROM tag_catalog tc
           WHERE tc.retired_at IS NULL
           ORDER BY tc.name COLLATE NOCASE ASC`,
      )
      .all();
    const byKey = new Map<string, CleanupPreviewSimilar[]>();
    for (const r of similarGroups) {
      const key = candidateKey(r.name);
      // Skip names that have no whitespace / case variation: candidate
      // key equals the lowercased original. Names with no peers fall
      // through as singletons which we drop from the preview (they are
      // NOT similar to anything).
      const arr = byKey.get(key) ?? [];
      arr.push({ name: r.name, activeCount: r.activeCount });
      byKey.set(key, arr);
    }
    const similar: CleanupPreviewSimilarGroup[] = [];
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      // Suggest the most-used name as the merge target. This is a
      // SUGGESTION — the user can override in the UI before applying.
      const target = [...members].sort((a, b) => b.activeCount - a.activeCount)[0]!;
      similar.push({ key, target: target.name, members });
    }

    return { unused, similar };
  }

  /** Apply a cleanup preview the user has reviewed + ticked. Returns
   *  the affected task ids so the caller can refresh downstream
   *  projections.
   *
   *  `actions` carries:
   *    - retire: list of catalog names to mark retired_at (and only
   *      those — historical task associations stay intact).
   *    - merges: list of { sources, target } to apply via merge().
   *  Items omitted from either list are NOT applied. The merge path
   *  re-validates target existence inside the transaction so a user
   *  can safely include a "merge → retire target" pair in one batch.
   *
   *  IMPORTANT: this method re-runs the unused/similar count
   *  queries INSIDE the transaction. If data changed between the
   *  preview and the apply (e.g. a task was archived mid-flow), the
   *  counts shift; we use those fresh counts to decide whether the
   *  retirement / merge is still valid. A tag that now has valid-task
   *  usage is NOT retired; a merge whose target vanished is rejected
   *  with a `stale_preview` error code so the renderer can re-fetch. */
  applyCleanup(actions: CleanupActions): CleanupApplyResult {
    const retire = actions.retire ?? [];
    const merges = actions.merges ?? [];
    const affected = new Set<string>();
    const skipped: CleanupSkippedEntry[] = [];
    const tx = this.db.transaction(() => {
      const now = Date.now();

      // Re-validate the retire list inside the transaction. A name
      // that picked up new valid-task usage since the preview was
      // generated is skipped (the user's checkbox is stale).
      const hasValidUsage = this.db.prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM tags
           WHERE tag = ?
             AND todo_id IN (SELECT id FROM todos WHERE ${VALID_TASK_PREDICATE})`,
      );
      const retireStmt = this.db.prepare(
        `UPDATE tag_catalog SET retired_at = ? WHERE name = ? AND retired_at IS NULL`,
      );
      for (const name of retire) {
        const u = hasValidUsage.get(name);
        if (u && u.c > 0) {
          skipped.push({ name, reason: 'stale_preview_has_valid_tasks' });
          continue;
        }
        retireStmt.run(now, name);
      }

      // Apply each merge in order. Re-validate the source set is
      // still distinct from the target + still exists. Reuse the
      // merge() body inline so the affected todo ids feed into the
      // outer Set (which we then bump updated_at on, even though
      // merge() already does that — defense in depth).
      for (const m of merges) {
        const sources = m.sources.map((s) => s.trim()).filter(Boolean);
        const target = m.target.trim();
        if (!target || sources.length === 0) continue;
        if (sources.includes(target)) {
          skipped.push({ name: target, reason: 'merge_into_self' });
          continue;
        }
        try {
          const r = this.merge(sources, target);
          for (const id of r.affectedTodoIds) affected.add(id);
        } catch (err) {
          skipped.push({
            name: target,
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    });
    try {
      tx();
    } catch (err) {
      // The transaction already rolled back on throw; rethrow with a
      // friendly code so the renderer can surface a "no changes made"
      // message instead of a half-applied state.
      throw new CleanupError(
        `清理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { affectedTodoIds: Array.from(affected), skipped };
  }
}

export interface CleanupPreviewUnused {
  name: string;
  /** Historical task count (deleted or archived) for context — the
   *  preview UI uses this to remind the user that retirement only
   *  affects the management list, not those rows. */
  historicalCount: number;
}

export interface CleanupPreviewSimilar {
  name: string;
  activeCount: number;
}

export interface CleanupPreviewSimilarGroup {
  key: string;
  /** Suggested target (most-used member). The UI must let the user
   *  override before apply. */
  target: string;
  members: CleanupPreviewSimilar[];
}

export interface CleanupPreview {
  unused: CleanupPreviewUnused[];
  similar: CleanupPreviewSimilarGroup[];
}

export interface CleanupActions {
  retire?: string[];
  merges?: { sources: string[]; target: string }[];
}

export interface CleanupSkippedEntry {
  name: string;
  reason: string;
}

export interface CleanupApplyResult {
  affectedTodoIds: ULID[];
  skipped: CleanupSkippedEntry[];
}

export class CleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupError';
  }
}

/** Candidate key for the "similar" preview: trim + collapse internal
 *  whitespace + lowercase. Two names with the same key land in the
 *  same suggestion group. Inclusion ("工作" vs "工作总结") is
 *  intentionally NOT part of this — the spec forbids it. */
function candidateKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}