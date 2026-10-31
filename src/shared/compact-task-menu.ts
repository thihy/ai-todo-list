import type { Priority, TodoStatus } from './todo-types';
export type CompactTaskAction = { kind: 'status'; value: TodoStatus } | { kind: 'priority'; value: Priority } | { kind: 'progress' } | null;
