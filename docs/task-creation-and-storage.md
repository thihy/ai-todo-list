# Task Creation and Storage Contracts

Status: implemented contract for the current desktop application.

This document is written for maintainers and AI coding agents. It explains the
two task-creation paths, the AI intent boundary, and the stable relationship
between a todo row and its local files.

## 1. Domain model

A task is a row in `todos`. The relevant user-facing fields are:

| Field | Meaning | Default / rule |
| --- | --- | --- |
| `title` | Actionable task title | Required |
| `status` | `next`, `doing`, `blocked`, `done`, `cancelled` | `next` |
| `priority` | `none`, `low`, `medium`, `high` | `none` |
| `dueAt` | Deadline as Unix milliseconds | Only when explicitly supplied |
| `tags` | User categories | Empty unless explicit or safely reused |
| `parentId` | Real parent task ID | `null`; never guessed |
| `plannedFor` | Local date for the Today section | Only for explicit “today” intent |
| `storage_dir` | Directory name under `{dataDir}/todos` | Stable DB association |

`project` is a legacy nullable string. There is no project entity, project
selector, project detail page, or complete project lifecycle. New creation UI
and AI task creation must not expose or populate it. Keeping the database field
is only a compatibility decision, not a product feature.

## 2. Two creation paths

### 2.1 Form creation

The form is deterministic. It collects known values and calls
`window.todoList.todo.create(input)` directly.

```text
Composer form
  -> preload todo.create
  -> IPC todo.create handler
  -> TodoRepo.create
  -> initialize task directory and projections
  -> broadcast todo data change
  -> navigate to the created task
```

The form currently exposes:

- title;
- status;
- priority;
- deadline date;
- comma-separated tags;
- “加入今日待办”.

It deliberately does not expose `project`. The form also does not invoke the
model, create an AI conversation, or infer missing values.

The date-only deadline is converted using the user’s local timezone to the end
of that date (`23:59:59.999`). `plannedFor` uses the local `YYYY-MM-DD` value.

### 2.2 AI creation

AI creation is an explicit application operation, not a heuristic based on the
user’s wording. The renderer carries:

```ts
{
  intent: 'create-task',
  prompt: string,
  images: Array<{ name: string; mime: string; dataUrl: string }>
}
```

If the AI panel is collapsed, `App` queues this request, opens/lazy-loads the
panel, and lets `AIPane` consume it when ready. A request waiting behind a
running turn or human-in-the-loop interaction remains queued.

The main process is responsible for producing the model-visible envelope:

```text
[todo-list:create-task:v1] {"intent":"create-task","localDate":"2026-09-13","text":"用户原文…"}
```

Properties of the envelope:

- `intent` is explicit and versioned by the prefix.
- `localDate` is computed for each request in the application’s local timezone.
- `text` preserves the literal description and attachment blocks.
- JSON escaping prevents user text from breaking structural delimiters.
- The envelope identifies an operation but is not an authorization boundary.
- User text is data and cannot override system-level creation rules.

The renderer decodes persisted messages before display, so the user sees their
literal text rather than the envelope. Legacy bracketed envelopes are decoded
strictly for history compatibility; loose marker matching is forbidden because
ordinary pasted text could otherwise be misclassified.

## 3. AI creation behavior

The canonical fixed rules live in `resources/dsh/cordis.yml`, not in the
renderer and not in user-authored text.

The model must:

1. Treat a `create-task` turn as an instruction to create real task rows.
2. Call `todo.create` when the description is sufficient.
3. Produce concise, actionable titles without envelope content.
4. Default to `next` and `none`.
5. Change status or priority only when supported by the description.
6. Avoid invented deadlines and subjective tags.
7. Use the envelope’s `localDate` for explicit Today requests.
8. Keep `dueAt` and `plannedFor` semantically separate.
9. Query real tasks before setting `parentId`; ask when matching is ambiguous.
10. Split clearly independent tasks into separate creates.
11. Ask only for essential missing information.
12. Briefly report what was actually created.

Ordinary side-panel chat has no create-task envelope. It must not silently
become task creation merely because the text resembles a task. An explicit
chat instruction such as “帮我创建一个任务” can still be handled according to
normal assistant intent and tool rules.

## 4. Stable task-directory association

SQLite is authoritative for identity and association. `todos.storage_dir`
stores the relative directory name under `{dataDir}/todos`.

For a new task, the preferred directory is:

```text
{first-six-todo-id-characters}-{slugified-title}
```

Example:

```text
01K4AB-完成季度报告
```

The ID prefix distinguishes same-title tasks; the title suffix is for humans.
The title is not the identity. Callers must use `TaskDirectoryStore.resolve()`
instead of reconstructing the path.

### First resolution and legacy adoption

If `storage_dir` is null, `TaskDirectoryStore` looks for known historical
layouts before creating a new directory:

1. `{idPrefix}-{currentSlug}`;
2. `{currentSlug}`;
3. `{currentSlug}-{lastFourIdCharacters}`.

When `todo.json` is present, its task ID is checked before adoption. The chosen
relative name is written to `storage_dir`; later resolutions use that value.

### Task rename

Task-title update and directory rename have deliberately different failure
semantics:

```text
update todo title in DB
  -> resolve currently associated directory
  -> attempt filesystem rename to {idPrefix}-{newSlug}
     -> success: update storage_dir, rewrite attachment absolute paths
     -> failure: keep old storage_dir and continue using the old directory
  -> write refreshed todo.json to the associated directory
```

A filesystem failure must not roll back the title change. More importantly, it
must not cause the next write to create a new directory derived from the new
title. The association remains valid even when the visible folder name is old.

Stores resolve on each operation rather than caching task directories. This is
necessary so a successful directory rename becomes visible immediately and a
failed rename continues to use the persisted old association.

## 5. Per-task files

All task-owned artifacts share the associated directory:

```text
{dataDir}/todos/{storage_dir}/
  todo.json
  progress.html
  {noteSlug}.md
  {drawingSlug}.excalidraw
  thumbs/{drawingId}.thumb.png
  attachments/{attachmentId}-{sanitizedFilename}
```

### `todo.json`

A best-effort metadata snapshot for file browsing, backup, and Git history.
The database remains authoritative.

### `progress.html`

The rich-text progress document uses a fixed filename. `document.write` writes
the version to SQLite and mirrors the latest HTML through `DocumentStore` into
the associated directory.

Do not confuse this document with:

- `todos.progress`: the numeric percentage used by progress bars;
- `progress_log`: the percentage/note timeline.

Those are separate domain concepts even though the UI groups them under
“进展/动态”.

### Notes

`note_md` documents are mirrored as `{slugifiedDocumentTitle}.md`. Renaming a
note best-effort renames its file inside the same task directory.

### Drawings

Drawing scenes are `{slugifiedDrawingTitle}.excalidraw`. The drawing DB row
stores task-relative path metadata. Thumbnails use the drawing ID and remain in
`thumbs/` when a drawing title changes.

### Attachments

Attachments are stored below `attachments/`. Their DB rows currently carry
absolute paths, so a successful task-directory rename must rewrite those rows.

## 6. Implementation map

| Responsibility | File |
| --- | --- |
| Form and AI-create UI | `src/renderer/components/Composer.tsx` |
| Queue collapsed-panel requests | `src/renderer/App.tsx` |
| Submit and render AI turns | `src/renderer/panes/AIPane.tsx` |
| Intent IPC contract | `src/shared/ipc-schema.ts`, `src/shared/todo-list-api.ts` |
| Envelope encode/decode | `src/shared/task-creation.ts` |
| Main AI request handling | `src/main/ipc/ai-handlers.ts` |
| Agent runtime/history | `src/main/dsh/dsh-runtime.ts` |
| Canonical AI rules | `resources/dsh/cordis.yml` |
| Task directory association | `src/main/files/task-directories.ts` |
| Safe path components | `src/main/files/paths.ts` |
| Rename and metadata snapshot | `src/main/files/rename-hooks.ts` |
| Text documents | `src/main/files/documents.ts` |
| Drawings | `src/main/files/drawings.ts` |
| Attachments | `src/main/files/inbox.ts` |
| Schema migrations | `src/main/db/schema.ts` |

## 7. Regression checklist

For task creation:

- form creation never calls AI;
- AI creation carries explicit intent through IPC;
- ordinary chat remains unwrapped;
- collapsed AI panel does not lose requests;
- user text round-trips through JSON and history;
- local date is computed per request;
- the UI never displays the internal envelope;
- project is absent from new creation flows.

For storage:

- repeated resolution returns the same associated directory;
- same-title tasks do not share an association;
- legacy directories are adopted instead of duplicated;
- successful rename moves all files and updates the association;
- failed rename preserves the old association and creates no replacement;
- progress, note, drawing, thumbnail, and attachment operations resolve through
  the same directory;
- `progress.html` is updated by rich progress-document edits;
- attachment absolute paths are rewritten only after a successful move.

## 8. Known documentation caveat

`docs/architecture.md` contains descriptions of an earlier flat Markdown and
separate drawings layout. For task creation and storage, this document and the
current source code take precedence until the broader architecture guide is
fully refreshed.

