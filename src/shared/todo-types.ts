// Single source of truth for all domain types. Shared by main, preload, renderer.

export type ULID = string;

// The task lifecycle. "未完成" (next) is the default entry state for any new
// task; "进行中" (doing) means actively worked; "已完成" (done) stamps doneAt
// and is eligible for auto-archive; "已取消" (cancelled) is a dropped/void
// task (terminal, but not done); "阻塞中" (blocked) is waiting on a
// dependency. There is no "inbox" state — the old 收件箱 concept collapsed
// into 未完成.
export type TodoStatus = 'next' | 'doing' | 'done' | 'cancelled' | 'blocked';
export type Priority = 'none' | 'low' | 'medium' | 'high';

export const TODO_STATUSES: readonly TodoStatus[] = ['next', 'doing', 'done', 'cancelled', 'blocked'];
export const PRIORITIES: readonly Priority[] = ['none', 'low', 'medium', 'high'];

export interface Todo {
  id: ULID;
  title: string;
  status: TodoStatus;
  priority: Priority;
  project: string | null;
  dueAt: number | null;
  bodyPath: string;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  tags: string[];
  attachmentIds: ULID[];
  drawingIds: ULID[];
  /** Parent todo id (SubTask support). null = top-level task. Cycles are
   *  rejected at the API boundary; deleting a parent sets this to NULL on
   *  its former children (ON DELETE SET NULL on the self-FK). */
  parentId: ULID | null;
  /** Soft-archive timestamp. null = active (shown in the default list).
   *  Set by the auto-archive sweep (done tasks older than the configured
   *  threshold) or manually. Archived tasks are excluded from the default
   *  list/search-of-active and surfaced via the 归档 view. */
  archivedAt: number | null;
}

export interface TodoCreate {
  title: string;
  status?: TodoStatus;
  priority?: Priority;
  project?: string | null;
  dueAt?: number | null;
  tags?: string[];
  /** Parent todo id for SubTask creation; null/omitted = top-level. */
  parentId?: ULID | null;
}

export interface TodoPatch {
  title?: string;
  status?: TodoStatus;
  priority?: Priority;
  project?: string | null;
  dueAt?: number | null;
  tags?: string[];
  /** Re-parent the task (make it a subtask of another task); null = promote
   *  to top-level. Cycles are rejected at the API boundary. */
  parentId?: ULID | null;
  /** Soft-archive / restore. A number (epoch ms) archives; null restores
   *  an archived task back to the active list. */
  archivedAt?: number | null;
}

export interface TodoFilter {
  status?: TodoStatus[];
  priority?: Priority[];
  project?: string[];
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