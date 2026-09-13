# ADR-005: Tag catalog mutations must not rewrite historical-task tags

- **Status:** Accepted. Implemented in v17 schema migration.
- **Date:** 2026-09.

## Context

Before v17, the only writable tag directory was the
`settings.tags` array in `${userData}/config.json`. That registry
could not enumerate names the user had never explicitly
registered, so every cleanup / "used by N tasks" query had to
walk the entire `tags` table — and was incomplete as soon as an
AI tool created a task with a name the user hadn't pre-registered.

Once tags became a first-class managed object (DB-backed
`tag_catalog` since v17, see
[`docs/architecture.md`](../architecture.md) §4–5), the obvious
"just rewrite every association" implementation is unsafe:

- a user may have deleted or archived a task because they
  regretted the tag(s) they used. The original tag string is
  part of the task's history and must remain readable.
- a rename of "工作" → "任务" should not retroactively rewrite the
  historical tasks that were tagged "工作"; those tasks' histories
  stay coherent with the user's original intent.
- an automated cleanup that "removes the tag" by deleting rows
  from `tags` is destructive: deleting a `tags` row also
  disappears the tag from the task's effective surface, even on
  historical tasks the user expected to stay readable.

## Decision

- `tag_catalog` is the single source of truth for tag metadata
  (name, colour, retired_at). The legacy `settings.tags` array is
  imported exactly once at boot and then ignored.
- `TagRepo.rename` and `TagRepo.merge` restrict their mutations
  to **valid-task associations** (where
  `todos.deleted_at IS NULL AND todos.archived_at IS NULL`,
  matching the predicate used by `TodoRepo.list` / filter /
  stats). They never touch the `tags` rows whose `todo_id` points
  at a deleted or archived task.
- A rename whose target name does not yet exist succeeds; one whose
  target exists is treated as a merge (with the same per-task
  restrictions). The user is never silently overwritten.
- A "retire" operation only sets `tag_catalog.retired_at = now`;
  it does not delete the catalog row and does not touch any
  `tags` association. Historical tasks keep their tag strings.
- `TagRepo.applyCleanup` re-validates each action inside a single
  SQLite transaction. A tag that picked up valid-task usage
  between the preview and the apply is *skipped* (returned in
  `CleanupApplyResult.skipped`) — the application never silently
  rewrites a stale plan onto fresh data.
- `TodoRepo.onTagsAttached` (the constructor hook) drives
  `TagRepo.activateUsedNames` after every create / update that
  touches `tags`: a brand-new name gets a fresh catalog row;
  a previously retired name is revived; an active name stays
  unchanged. Restoring a task thus re-activates the tags it
  carries, with no UI round-trip required.

## Impact

- The user always sees the tag string they originally typed for
  any task, including tasks they later archived or deleted.
- The management UI can confidently say "this rename / merge
  affects N valid tasks" because the count and the affected set
  are bounded by the same predicate.
- Cleanup operations can be reviewed in the preview dialog with
  predictable semantics: no implicit deletes, no silent
  reclassifications.
- The catalog itself remains durable across retires; no orphan
  data accumulates, but no historical-tag information is lost
  either.

## Boundaries

- A user-initiated "delete tag entirely" action is intentionally
  *not* a supported management operation. The closest supported
  action is retire + accept that historical tasks retain the
  name. A future "permanently delete" feature would need a
  separate decision (likely a destructive confirmation dialog
  and a "show me which tasks this affects" preview).
- AI suggestions (`ai.suggestTags`) can propose names that do
  not yet exist in the catalog. The renderer's `TagInput` accepts
  any string; the catalog row is created the moment a task with
  that tag is saved through `TodoRepo.onTagsAttached`.
- ADR-001 still applies: the catalog row is in the DB, but the
  actual association lives in `tags` and is a projection of the
  user's intent at the time they wrote it.
