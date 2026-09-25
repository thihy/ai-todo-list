// Settings store round-trip with redaction of API key.

// logger.ts eagerly reads `app.getPath('userData')` at module load
// (see src/main/logger.ts:12). Our SettingsStore.patch() does a
// dynamic import of it on every patch to forward the new logLevel,
// so we must stub electron so the eager call doesn't crash in
// vitest where `app` is undefined.
vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'todo-list-settings-test-userData') },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  // 桌面悬浮宠物：默认关闭、null 位置；可以打补丁；旧 config.json 缺字段
  // 时 load() 回退到默认值；坏值（NaN / 字符串）归一化成 null；normalisePet
  // 不抛错；publicView 暴露 enabled + x + y 三个字段。
  it('defaults pet to disabled with null position', () => {
    const v = store.get();
    expect(v.pet.enabled).toBe(false);
    expect(v.pet.x).toBeNull();
    expect(v.pet.y).toBeNull();
  });

  it('patches pet enabled and position', () => {
    store.patch({ pet: { enabled: true, x: 200, y: 300 } });
    const reloaded = new SettingsStore(dir).get();
    expect(reloaded.pet.enabled).toBe(true);
    expect(reloaded.pet.x).toBe(200);
    expect(reloaded.pet.y).toBe(300);
  });

  it('exposes pet in publicView', () => {
    store.patch({ pet: { enabled: true, x: 100, y: 200 } });
    const view = store.publicView();
    expect(view.pet.enabled).toBe(true);
    expect(view.pet.x).toBe(100);
    expect(view.pet.y).toBe(200);
  });

  it('normalises pet x/y NaN / non-number to null on patch', () => {
    // Cast through `as never` to bypass the strict SettingsPatchArgs type
    // guard — we want the runtime normalisePet to be exercised.
    store.patch({
      pet: {
        enabled: true,
        x: Number.NaN as unknown as number,
        y: 'foo' as unknown as number,
      },
    });
    const v = store.get();
    expect(v.pet.enabled).toBe(true);
    expect(v.pet.x).toBeNull();
    expect(v.pet.y).toBeNull();
  });

  // 回归：`settings.set` 的主进程 handler 是逐字段白名单展开的。pet
  // 曾经漏在白名单外，渲染层勾选「启用悬浮宠物」发出去的
  // { pet: { enabled: true } } 被整个丢弃 → publicView() 回传
  // enabled:false → 受控 checkbox 立刻弹回。这两个用例锁住
  // 「只发 enabled 不清位置」和「只发位置不动 enabled」两条语义，
  // 「重置位置」按钮和设置页勾选框都依赖它们。
  it('patching only pet.enabled preserves an existing position', () => {
    store.patch({ pet: { x: 640, y: 480 } });
    store.patch({ pet: { enabled: true } });
    const v = store.get();
    expect(v.pet.enabled).toBe(true);
    expect(v.pet.x).toBe(640);
    expect(v.pet.y).toBe(480);
  });

  it('resetting only pet.x/y leaves pet.enabled untouched', () => {
    store.patch({ pet: { enabled: true } });
    store.patch({ pet: { x: 100, y: 200 } });
    // 「重置位置」发 { x: null, y: null }
    store.patch({ pet: { x: null, y: null } });
    const v = store.get();
    expect(v.pet.enabled).toBe(true);
    expect(v.pet.x).toBeNull();
    expect(v.pet.y).toBeNull();
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});