import { describe, expect, it } from 'vitest';
import { localDateKey, selectCompactTasks } from '../../src/shared/compact-tasks';
import type { Todo } from '../../src/shared/todo-types';
const todo = (id: string, patch: Partial<Todo> = {}): Todo => ({ id, title: id, status: 'next', priority: 'low',
  dueAt: null, bodyPath: '', createdAt: 1, updatedAt: 1, doneAt: null, tags: [], drawingIds: [], attachmentIds: [],
  parentId: null, archivedAt: null, deletedAt: null, progress: 0, plannedFor: null, selectedDocTab: null, ...patch });
describe('compact task selection', () => {
  it('prioritizes today, due dates, then recent updates without a fixed row limit', () => {
    const input = [todo('undated'), todo('other-urgent', { dueAt: 1 }),
      todo('today-undated', { plannedFor: '2026-10-30' }),
      todo('today-due', { plannedFor: '2026-10-30', dueAt: 20 }),
      todo('today-first', { plannedFor: '2026-10-30', dueAt: 10 }),
      todo('recent-undated', { updatedAt: 3 }), todo('older-undated', { updatedAt: 2 })];
    expect(selectCompactTasks(input, '2026-10-30').map((t) => t.id)).toEqual([
      'today-first', 'today-due', 'today-undated', 'other-urgent', 'recent-undated', 'older-undated', 'undated',
    ]);
    expect(input[0]!.id).toBe('undated');
  });
  it('excludes terminal, archived and deleted tasks, including descendants normally returned by list', () => {
    const input = [todo('done', { status: 'done' }), todo('cancelled', { status: 'cancelled' }),
      todo('archived', { archivedAt: 1 }), todo('deleted', { deletedAt: 1 }),
      todo('working', { status: 'doing' }), todo('blocked', { status: 'blocked' })];
    expect(selectCompactTasks(input).map((t) => t.id)).toEqual(['blocked', 'working']);
  });
  it('uses local calendar dates and changes today membership after midnight', () => {
    expect(localDateKey(new Date(2026, 0, 2, 0, 1))).toBe('2026-01-02');
    const input = [todo('today', { plannedFor: '2026-10-30' }), todo('tomorrow', { plannedFor: '2026-10-31' })];
    expect(selectCompactTasks(input, '2026-10-30')[0]!.id).toBe('today');
    expect(selectCompactTasks(input, '2026-10-31')[0]!.id).toBe('tomorrow');
    expect(selectCompactTasks([])).toEqual([]);
  });
});
