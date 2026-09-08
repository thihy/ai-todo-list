// Single source of truth for all domain types. Shared by main, preload, renderer.

export type ULID = string;

export type TodoStatus = 'inbox' | 'next' | 'doing' | 'blocked' | 'done';
export type Priority = 'none' | 'low' | 'medium' | 'high';

export const TODO_STATUSES: readonly TodoStatus[] = ['inbox', 'next', 'doing', 'blocked', 'done'];
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
  /** Group (directory) this task belongs to, or null for the root/unfiled area. */
  groupId: ULID | null;
  /** Parent todo id (SubTask support). null = top-level task. Cycles are
   *  rejected at the API boundary; deleting a parent sets this to NULL on
   *  its former children (ON DELETE SET NULL on the self-FK). */
  parentId: ULID | null;
}

export interface TodoCreate {
  title: string;
  status?: TodoStatus;
  priority?: Priority;
  project?: string | null;
  dueAt?: number | null;
  tags?: string[];
  /** Group to file this task under; null/omitted = unfiled. */
  groupId?: ULID | null;
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
  /** Move the task to a different group; null = unfiled. */
  groupId?: ULID | null;
  /** Re-parent the task (make it a subtask of another task); null = promote
   *  to top-level. Cycles are rejected at the API boundary. */
  parentId?: ULID | null;
}

export interface TodoFilter {
  status?: TodoStatus[];
  priority?: Priority[];
  project?: string[];
  tag?: string[];
  /** Restrict to tasks in any of these groups (no descendant expansion — caller resolves). */
  groupIds?: ULID[];
  dueBefore?: number | null;
  dueAfter?: number | null;
  search?: string;
  /** Restrict to direct children of this parent id; null = top-level tasks only. */
  parentId?: ULID | null;
}

// ----- Groups (hand-edited directory tree; tasks are "files" in a group) -----

export interface Group {
  id: ULID;
  name: string;
  parentId: ULID | null;
  sortOrder: number;
  createdAt: number;
}

/** Task counts per group, keyed by group id (null key = unfiled). */
export type GroupCounts = Record<string, number>;

export interface GroupCreate {
  name: string;
  parentId?: ULID | null;
}

export interface GroupPatch {
  name?: string;
  parentId?: ULID | null;
  sortOrder?: number;
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