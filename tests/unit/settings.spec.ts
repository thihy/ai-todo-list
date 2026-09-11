// Settings store round-trip with redaction of API key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../src/main/settings/store';

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-list-settings-'));
  store = new SettingsStore(dir);
});

describe('SettingsStore', () => {
  it('returns defaults when config is missing', () => {
    const v = store.get();
    expect(v.model).toBe('deepseek-chat');
    expect(v.streaming).toBe(true);
    expect(v.apiKey).toBeNull();
  });

  it('patches and persists', () => {
    store.patch({ model: 'deepseek-reasoner', streaming: false });
    const reloaded = new SettingsStore(dir).get();
    expect(reloaded.model).toBe('deepseek-reasoner');
    expect(reloaded.streaming).toBe(false);
  });

  it('redacts apiKey in public view', () => {
    store.patch({ apiKey: 'sk-abcdefgh-1234567890' });
    const view = store.publicView();
    expect(view.apiKeyRedacted).toContain('*');
    expect(view.apiKeyRedacted).not.toContain('abcdefgh');
    expect(view.connected).toBe(true);
  });

  it('records heartbeat and accumulates cost', () => {
    store.recordHeartbeat();
    store.addCost(0.123);
    store.addCost(0.045);
    const v = store.get();
    expect(v.lastHeartbeatAt).not.toBeNull();
    expect(Math.abs(v.monthlyCostUsd - 0.168)).toBeLessThan(1e-6);
  });

  // 「今日待办」 三字段：默认 / round-trip / publicView 暴露。用来锁住
  // PlanGuideModal / plan-reminder 的契约。
  it('default plan-guide fields', () => {
    const v = store.get();
    expect(v.dailyPlanReminderTime).toBe('09:00');
    expect(v.lastPlanGuideDate).toBeNull();
    expect(v.snoozePlanGuideUntil).toBeNull();
  });

  it('patches and persists plan-guide fields', () => {
    store.patch({
      dailyPlanReminderTime: '07:30',
      lastPlanGuideDate: '2026-09-11',
      snoozePlanGuideUntil: 1_726_100_000_000,
    });
    const reloaded = new SettingsStore(dir).get();
    expect(reloaded.dailyPlanReminderTime).toBe('07:30');
    expect(reloaded.lastPlanGuideDate).toBe('2026-09-11');
    expect(reloaded.snoozePlanGuideUntil).toBe(1_726_100_000_000);
  });

  it('exposes plan-guide fields in publicView', () => {
    store.patch({
      dailyPlanReminderTime: '08:00',
      lastPlanGuideDate: '2026-09-10',
      snoozePlanGuideUntil: 1_726_099_000_000,
    });
    const view = store.publicView();
    expect(view.dailyPlanReminderTime).toBe('08:00');
    expect(view.lastPlanGuideDate).toBe('2026-09-10');
    expect(view.snoozePlanGuideUntil).toBe(1_726_099_000_000);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});