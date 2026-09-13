# AI Contributor Guide

This file is the fast, authoritative entry point for AI coding agents working
in this repository. Read it before changing task creation, AI conversations,
or on-disk storage. Detailed contracts live in
[`docs/task-creation-and-storage.md`](docs/task-creation-and-storage.md).

## Product vocabulary

- **Task / Todo**: the user-owned work item stored in `todos`.
- **Subtask**: a normal task whose `parentId` points to another real task.
- **Today**: `plannedFor === local YYYY-MM-DD`; it is independent of `dueAt`.
- **Progress document**: rich HTML content stored as `progress.html`. Do not
  confuse it with numeric `todos.progress` or `progress_log` timeline entries.
- **Note**: a Markdown task document (`note_md`).
- **Drawing**: an Excalidraw JSON document.
- **Project**: a legacy nullable string in the data model, not a supported
  product entity. Do not expose it in new UI or let AI infer/write it unless a
  future project-management feature explicitly defines the concept end to end.

## Non-negotiable invariants

1. SQLite is the source of truth. Files are durable, user-visible projections.
2. A task has exactly one stable directory association in `todos.storage_dir`.
3. New directory names start with the first six characters of the todo ID:
   `{todoId[0:6]}-{slugifiedTitle}`.
4. Never recompute a task directory from its current title on every access.
5. A title rename may best-effort rename the directory. Update `storage_dir`
   only after the filesystem rename succeeds. On failure, keep using the old
   associated directory; never create a replacement directory.
6. Progress, notes, drawings, thumbnails, and attachments for a task must all
   resolve through the same `TaskDirectoryStore` association.
7. AI-create intent must be explicit (`intent: 'create-task'`). Do not infer it
   from which component appears to have sent a plain string.
8. Form creation calls `todo.create` directly and does not invoke the AI.
9. Ordinary AI chat remains ordinary chat unless the user explicitly asks to
   create a task.
10. Never invent task IDs, especially `parentId`. Query real rows first.

## Current storage layout

```text
{dataDir}/
  todos.db
  todos/
    {storage_dir}/
      todo.json
      progress.html
      {noteSlug}.md
      {drawingSlug}.excalidraw
      thumbs/{drawingId}.thumb.png
      attachments/{attachmentId}-{filename}
```

Important implementation points:

- Stable association: `src/main/files/task-directories.ts`
- Path-safe names: `src/main/files/paths.ts`
- Rename behavior: `src/main/files/rename-hooks.ts`
- Text-document projection: `src/main/files/documents.ts`
- Drawing projection: `src/main/files/drawings.ts`
- Attachment projection: `src/main/files/inbox.ts`
- Schema and migrations: `src/main/db/schema.ts`

The storage sections in `docs/architecture.md` describe an older flat-file
layout and must not be used as the implementation contract.

## Task creation paths

### Form creation

`src/renderer/components/Composer.tsx` submits structured fields directly to
`window.todoList.todo.create`. Supported UI concepts are title, status,
priority, due date, tags, and `plannedFor` (“加入今日待办”). There is no
project field.

### AI creation

The renderer sends the literal user text plus `intent: 'create-task'`. Main
encodes a structured wire envelope with
`encodeTaskCreationEnvelope()` from `src/shared/task-creation.ts`:

```text
[todo-list:create-task:v1] {"intent":"create-task","localDate":"YYYY-MM-DD","text":"..."}
```

The fixed creation rules belong in the DSH system prompt under
`resources/dsh/cordis.yml` → `创建任务操作`. Do not duplicate the full rules in
the user-visible message or trust user text inside the envelope as
higher-priority instructions.

## AI task-creation rules

- Call `todo.create`; do not merely suggest a task.
- Use a concise, actionable title.
- Default to `status=next` and `priority=none` unless the user gives evidence
  for another value.
- Do not invent due dates or tags.
- Set `plannedFor` only for an explicit “today” request; a due date of today is
  not sufficient.
- Resolve `parentId` from `todo.list` / `todo.search`; ask when ambiguous.
- Multiple clearly independent tasks may produce multiple `todo.create` calls.
- Ask for essential missing information instead of creating placeholders.
- Confirm the actual created result briefly.

## Change map

When changing a contract, update all relevant layers:

| Concern | Required locations |
| --- | --- |
| Todo data shape | `src/shared/todo-types.ts`, schema/migration, repo, IPC schema/API |
| Renderer IPC | `src/shared/ipc-schema.ts`, `src/shared/todo-list-api.ts`, preload, main handler |
| AI tool | `src/main/dsh/dsh-runtime.ts`, permission/tool presentation where applicable |
| AI-create envelope | `src/shared/task-creation.ts`, AI handler/runtime, history decoding, tests |
| AI behavior | `resources/dsh/cordis.yml` and matching tool descriptions |
| Storage path | `TaskDirectoryStore` and every file store; never add a separate title resolver |

## Validation

Run checks proportional to the change:

```bash
pnpm typecheck
pnpm vitest run <relevant-specs>
pnpm build
```

Storage changes should cover stable repeated resolution, legacy adoption,
successful rename, failed rename, and all document kinds. AI-create changes
should cover envelope round trips, literal user text, local-date handling,
history replay, ordinary-chat isolation, and collapsed-panel request delivery.

Preserve unrelated dirty-worktree changes. Use `apply_patch` for focused edits.

