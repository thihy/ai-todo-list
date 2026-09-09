// app-context — the focus singleton that the renderer pushes its "what's
// currently open" pointer to, and the AI reads via app.currentContext. Pin
// the round-trip semantics so a future refactor doesn't accidentally:
//   - hold on to stale focus across tasks (the AI then hallucinates docs that
//     aren't really open);
//   - drop the task title (the AI has to make a separate todo.get call that
//     may go stale before the answer streams);
//   - reject null (null is the legitimate "nothing focused" state).

import { describe, it, expect, beforeEach } from 'vitest';
import { getFocus, setFocus, clearFocus } from '../../src/main/app-context';

describe('app-context (focus pointer)', () => {
  beforeEach(() => {
    clearFocus();
  });

  it('starts cleared', () => {
    expect(getFocus()).toBeNull();
  });

  it('round-trips a task focus', () => {
    setFocus({ kind: 'task', todoId: 't1' as never, taskTitle: 'Write plan' });
    expect(getFocus()).toEqual({ kind: 'task', todoId: 't1', taskTitle: 'Write plan' });
  });

  it('round-trips a document focus with all fields', () => {
    setFocus({
      kind: 'document',
      todoId: 't1' as never,
      documentId: 'd1' as never,
      documentKind: 'progress',
      documentTitle: '进展',
    });
    expect(getFocus()).toEqual({
      kind: 'document',
      todoId: 't1',
      documentId: 'd1',
      documentKind: 'progress',
      documentTitle: '进展',
    });
  });

  it('round-trips a drawing focus with a nullable title', () => {
    setFocus({
      kind: 'drawing',
      todoId: 't1' as never,
      drawingId: 'g1' as never,
      drawingTitle: null,
    });
    expect(getFocus()).toEqual({
      kind: 'drawing',
      todoId: 't1',
      drawingId: 'g1',
      drawingTitle: null,
    });
  });

  it('last-write-wins: a later document focus replaces the earlier task focus', () => {
    setFocus({ kind: 'task', todoId: 't1' as never, taskTitle: 'old' });
    setFocus({
      kind: 'document',
      todoId: 't1' as never,
      documentId: 'd2' as never,
      documentKind: 'note_md',
      documentTitle: 'note',
    });
    expect(getFocus()?.kind).toBe('document');
  });

  it('null clears the focus', () => {
    setFocus({ kind: 'task', todoId: 't1' as never, taskTitle: 'x' });
    setFocus(null);
    expect(getFocus()).toBeNull();
  });
});