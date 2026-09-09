// Tier classification: ensures every registered tool has a tier and that
// tier transitions match the policy in design.md §4.

import { describe, it, expect } from 'vitest';
import {
  SAFE_TOOLS,
  NOTIFY_UNDO_TOOLS,
  DESTRUCTIVE_TOOLS,
  tierFor,
} from '../../src/shared/permission-tiers';

describe('Permission tiers', () => {
  it('safe tools are auto', () => {
    for (const t of SAFE_TOOLS) expect(tierFor(t)).toBe('auto');
  });

  it('notify-undo tools are notify-undo', () => {
    for (const t of NOTIFY_UNDO_TOOLS) expect(tierFor(t)).toBe('notify-undo');
  });

  it('destructive tools are block', () => {
    for (const t of DESTRUCTIVE_TOOLS) expect(tierFor(t)).toBe('block');
  });

  it('disjoint sets', () => {
    const all = new Set<string>();
    for (const t of SAFE_TOOLS) expect(all.has(t)).toBe(false), all.add(t);
    for (const t of NOTIFY_UNDO_TOOLS) expect(all.has(t)).toBe(false), all.add(t);
    for (const t of DESTRUCTIVE_TOOLS) expect(all.has(t)).toBe(false), all.add(t);
  });

  it('unknown tool defaults to block', () => {
    expect(tierFor('not.a.real.tool')).toBe('block');
  });

  it('delete is destructive', () => {
    expect(tierFor('todo.delete')).toBe('block');
    expect(tierFor('drawing.delete')).toBe('block');
    expect(tierFor('content.restoreVersion')).toBe('block');
  });

  it('restore is safe (undo of a delete)', () => {
    expect(tierFor('todo.restore')).toBe('auto');
  });

  it('list/read are safe', () => {
    expect(tierFor('todo.list')).toBe('auto');
    expect(tierFor('todo.get')).toBe('auto');
    expect(tierFor('drawing.read')).toBe('auto');
  });
});