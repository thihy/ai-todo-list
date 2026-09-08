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
}

export interface TodoCreate {
  title: string;
  status?: TodoStatus;
  priority?: Priority;
  project?: string | null;
  dueAt?: number | null;
  tags?: string[];
}

export interface TodoPatch {
  title?: string;
  status?: TodoStatus;
  priority?: Priority;
  project?: string | null;
  dueAt?: number | null;
  tags?: string[];
}

export interface TodoFilter {
  status?: TodoStatus[];
  priority?: Priority[];
  project?: string[];
  tag?: string[];
  dueBefore?: number | null;
  dueAfter?: number | null;
  search?: string;
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