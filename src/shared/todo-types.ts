// Single source of truth for all domain types. Shared by main, preload, renderer.

export type ULID = string;

// The task lifecycle. "未完成" (next) is the default entry state for any new
// task; "进行中" (doing) means actively worked; "已完成" (done) stamps doneAt
// and is eligible for auto-archive; "已取消" (cancelled) is a dropped/void
// task (terminal, but not done); "阻塞中" (blocked) is waiting on a
// dependency. There is no "inbox" state — the old 收件箱 concept collapsed
// into 未完成.
export type TodoStatus = 'next' | 'doing' | 'done' | 'cancelled' | 'blocked';
// 5 档优先级（必选；不再有 "无 / none" 选项）。从低到高：very-low / low /
// medium / high / very-high。low 是新任务的默认档 —— 旧版本默认是 "无优先
// 级"，最自然的迁移目标就是新体系里最低的一档。DB schema v18 把历史 'none'
// 行迁移为 'low'；持久化层、AI 工具描述、UI 选项全部对齐。
export type Priority = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

/** A tag registry entry. Tags on a todo are plain strings (Todo.tags); this
 *  registry holds the user-chosen colour for each name, managed in Settings
 *  and surfaced as autocomplete in the task detail. `name` is the identity
 *  (case-insensitive unique); `color` is a CSS colour string. */
export interface TagDef {
  name: string;
  color: string;
}

export const TODO_STATUSES: readonly TodoStatus[] = ['next', 'doing', 'done', 'cancelled', 'blocked'];
// 从低到高，UI 选项 / 排序权重 / CSS 选择器 / AI 校验都引用同一份数组。
// 越靠前优先级越低。todo-list 的默认排序：高 → 低，所以会反向遍历。
export const PRIORITIES: readonly Priority[] = ['very-low', 'low', 'medium', 'high', 'very-high'];

export interface Todo {
  id: ULID;
  title: string;
  status: TodoStatus;
  priority: Priority;
  dueAt: number | null;
  bodyPath: string;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  tags: string[];
  attachmentIds: ULID[];
  drawingIds: ULID[];
  /** Parent todo id (SubTask support). null = top-level task. Cycles are
   *  rejected at the API boundary; deleting a parent soft-deletes its whole
   *  subtree (the repo cascades deleted_at), so children are never orphaned. */
  parentId: ULID | null;
  /** Soft-archive timestamp. null = active (shown in the default list).
   *  Set by the auto-archive sweep (done tasks older than the configured
   *  threshold) or manually. Archived tasks are excluded from the default
   *  list/search-of-active and surfaced via the 归档 view. */
  archivedAt: number | null;
  /** Soft-delete timestamp. null = live. Set by todo.delete (which cascades
   *  to the whole subtree); cleared by todo.restore. Deleted tasks are
   *  excluded from every default view (list, search, stats) and surfaced via
   *  the 已删除 filter view (deletedOnly). The row + markdown + drawings
   *  survive so a delete is always undoable. */
  deletedAt: number | null;
  /** Progress percent 0–100, mirrored on the todos row for at-a-glance bar
   *  rendering. Source of truth for "how far along is this task". Every
   *  change is appended to `progress_log` (with an optional one-line note)
   *  so the timeline is a complete audit — see ProgressLogEntry. */
  progress: number;
  /** "今天要干的" stamp: the local-date 'YYYY-MM-DD' this task is planned
   *  for, or null when not part of today's plan. Compared by exact equality
   *  (not a range) so a task planned for yesterday naturally drops off the
   *  今日待办 upper section on the next morning without any sweep — the
   *  renderer compares against today's local-date string (the same format).
   *  Date strings (not ms) keep the stamp tz-stable: the value you wrote is
   *  the value you read regardless of where the laptop wakes up later.
   *  Updated via todo.update({plannedFor}); the AI exposes it as
   *  todo.planForToday + todo.unplan tools. */
  plannedFor: string | null;
  /** Currently selected document tab in this task's DocumentsView, in the
   *  renderer's composite id form (`d:<docId>` / `g:<drawingId>`). Persisted
   *  so the tab survives task switching AND app restart. null = never set;
   *  the renderer auto-selects the first tab on open and writes it back via
   *  the dedicated `todo.setSelectedDoc` channel (NOT todo.update — a tab
   *  click must not bump updated_at and reorder the task list). */
  selectedDocTab: string | null;
}

export interface TodoCreate {
  title: string;
  status?: TodoStatus;
  priority?: Priority;
  dueAt?: number | null;
  tags?: string[];
  /** Parent todo id for SubTask creation; null/omitted = top-level. */
  parentId?: ULID | null;
  /** Initial "今天要干的" stamp. Typically computed at the call site as
   *  today's local-date 'YYYY-MM-DD' — pass the same value the renderer
   *  reads back when matching the upper section. */
  plannedFor?: string | null;
}

export interface TodoPatch {
  title?: string;
  status?: TodoStatus;
  priority?: Priority;
  dueAt?: number | null;
  tags?: string[];
  /** Re-parent the task (make it a subtask of another task); null = promote
   *  to top-level. Cycles are rejected at the API boundary. */
  parentId?: ULID | null;
  /** Soft-archive / restore. A number (epoch ms) archives; null restores
   *  an archived task back to the active list. */
  archivedAt?: number | null;
  /** Progress percent 0–100. Setting it via todo.update writes the column
   *  AND appends a note-less progress_log row when the value changes, so the
   *  audit timeline stays complete even for AI/batch mutations. For the
   *  user-facing "record progress with a note" path, prefer progress.log. */
  progress?: number;
  /** Add/remove the task from today's plan. The renderer sets this to
   *  today's local-date 'YYYY-MM-DD' to add, or null to remove. The
   *  patch-map semantics are the same as archivedAt (undefined = no
   *  change, null = clear). */
  plannedFor?: string | null;
}

export interface TodoFilter {
  status?: TodoStatus[];
  priority?: Priority[];
  tag?: string[];
  dueBefore?: number | null;
  dueAfter?: number | null;
  search?: string;
  /** Restrict to direct children of this parent id; null = top-level tasks only. */
  parentId?: ULID | null;
  /** Include already-archived tasks in the result. Default (false/omitted)
   *  excludes them so the active list stays decluttered. */
  includeArchived?: boolean;
  /** Only archived tasks (archived_at IS NOT NULL). For the 归档 view. */
  archivedOnly?: boolean;
  /** Only soft-deleted tasks (deleted_at IS NOT NULL). For the 已删除
   *  recovery view. Deleted tasks are excluded from every other list query
   *  regardless of other filters, so this is the sole way to surface them. */
  deletedOnly?: boolean;
}

export interface TodoStats {
  total: number;
  byStatus: Record<TodoStatus, number>;
  completionRate7d: number;
  avgDoneLatencyMs: number;
}

export interface ContentVersionEntry {
  id: number;
  todoId: ULID;
  body: string;
  savedAt: number;
}

/** One entry in a task's git-backed save history (separate from the DB
 *  content_versions used for AI session restore). Returned by
 *  content.gitHistory. `available: false` means git isn't on PATH — the
 *  editor's History button then quietly hides itself. */
export interface GitHistoryEntry {
  sha: string;
  message: string;
  authorTs: number;
}

/** One entry in a task's progress audit log. Every progress mutation appends
 *  a row: progress.log() with the user's optional one-line note, or
 *  todo.update({progress}) with a null note when an AI/batch path sets the
 *  value. Newest-first is the canonical listing order (progress.list). */
export interface ProgressLogEntry {
  id: ULID;
  todoId: ULID;
  percent: number;
  note: string | null;
  createdAt: number;
}

// ----- Multi-document workspace (schema v11) -----
//
// A task owns a list of `task_documents` rows. Each row is one document the
// user can open in the detail body workspace. `kind` decides where the
// content lives and which editor renders it:
//
//   progress   — the default WYSIWYG rich-text doc (one per task, auto-created).
//                 Content (HTML) is versioned in `document_versions`.
//   note_md    — a Markdown doc. Content versioned in `document_versions`.
//   drawing    — an Excalidraw drawing; refId → rows in the `drawings` table.
//   attachment — a file (incl. pasted images); refId → `inbox_attachments`.
//   link       — a hyperlink; `url` holds the URL, no file.

export type DocumentKind = 'progress' | 'note_md' | 'drawing' | 'attachment' | 'link';

export interface TaskDocument {
  id: ULID;
  todoId: ULID;
  kind: DocumentKind;
  title: string | null;
  /** Points to the kind-specific record: a drawings.id (drawing) or an
   *  inbox_attachments.id (attachment). null for progress / note_md / link. */
  refId: string | null;
  /** URL for kind === 'link'. null otherwise. */
  url: string | null;
  /** Short page description for kind === 'link' — the fetched <meta
   *  description> / og:description, shown as a subtitle under the link
   *  title. null when the page had none or the fetch failed (best-effort).
   *  Unused (null) for other kinds. */
  description: string | null;
  /** Display order within the task (0 = first; progress is always 0). */
  ord: number;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentVersionEntry {
  id: number;
  documentId: ULID;
  content: string;
  savedAt: number;
}

export interface DrawingMeta {
  id: ULID;
  todoId: ULID;
  title: string | null;
  thumbPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SearchHit {
  todo: Todo;
  snippet: string;
  score: number;
}

export interface InboxAttachment {
  id: ULID;
  todoId: ULID;
  filePath: string;
  mime: string;
  createdAt: number;
}

export interface DrawingScene {
  elements: unknown[];
  appState: Record<string, unknown>;
}