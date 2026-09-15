// 「今日待办」 定时提醒 —— shouldFire + todayDateKey 都是纯函数,不需要
// electron / DB,这里集中测一下边界。

import { describe, it, expect } from 'vitest';
import { shouldFire, todayDateKey } from '../../src/main/notification/plan-reminder';

const base = {
  now: '09:00',
  target: '09:00',
  plannedToday: 0,
  activeTotal: 3,
  snoozeUntil: null as number | null,
  nowMs: 1_700_000_000_000,
};

describe('plan-reminder.shouldFire', () => {
  it('fires when HH:MM matches and nothing planned and no snooze', () => {
    expect(shouldFire(base)).toBe(true);
  });

  it('suppresses when HH:MM differs', () => {
    expect(shouldFire({ ...base, now: '09:01' })).toBe(false);
    expect(shouldFire({ ...base, now: '08:59' })).toBe(false);
  });

  it('suppresses when something is already planned for today', () => {
    expect(shouldFire({ ...base, plannedToday: 1 })).toBe(false);
  });

  it('suppresses during snooze window', () => {
    expect(shouldFire({ ...base, snoozeUntil: base.nowMs + 60_000 })).toBe(false);
  });

  it('fires after snooze has expired', () => {
    expect(shouldFire({ ...base, snoozeUntil: base.nowMs - 1 })).toBe(true);
  });

  it('snoozeUntil === nowMs counts as expired (boundary)', () => {
    // Strict > means exactly equal to now is no longer suppressed.
    expect(shouldFire({ ...base, snoozeUntil: base.nowMs })).toBe(true);
  });

  it('suppresses when there are no active tasks at all', () => {
    // 没有任何任务可安排时，"今天安排些什么？"没意义，不弹。
    expect(shouldFire({ ...base, activeTotal: 0 })).toBe(false);
  });
});

describe('plan-reminder.todayDateKey', () => {
  it('formats local date as YYYY-MM-DD with zero-padded month/day', () => {
    // Sep 11 2026 → 2026-09-11
    expect(todayDateKey(new Date(2026, 8, 11, 14, 27, 33))).toBe('2026-09-11');
  });

  it('zero-pads single-digit month and day', () => {
    expect(todayDateKey(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05');
    expect(todayDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('two calls within the same local day return the same key', () => {
    const a = todayDateKey(new Date(2026, 8, 11, 0, 0, 0));
    const b = todayDateKey(new Date(2026, 8, 11, 23, 59, 59));
    expect(a).toBe(b);
    expect(a).toBe('2026-09-11');
  });

  it('rolls forward at local midnight', () => {
    expect(todayDateKey(new Date(2026, 8, 11, 23, 59, 59))).toBe('2026-09-11');
    expect(todayDateKey(new Date(2026, 8, 12, 0, 0, 1))).toBe('2026-09-12');
  });
});
