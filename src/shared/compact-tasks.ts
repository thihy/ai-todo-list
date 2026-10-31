import type { Todo } from './todo-types';

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function selectCompactTasks(todos: readonly Todo[], today = localDateKey()): Todo[] {
  return todos.filter((todo) => ['next', 'doing', 'blocked'].includes(todo.status) &&
    todo.archivedAt === null && todo.deletedAt === null)
    .sort((a, b) => Number(b.plannedFor === today) - Number(a.plannedFor === today) ||
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
