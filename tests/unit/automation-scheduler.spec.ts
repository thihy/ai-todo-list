import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationScheduler, nextRun, validateAutomation } from '../../src/main/automation/scheduler';
import type { AutomationInput } from '../../src/shared/automation-types';

const input = (patch: Partial<AutomationInput> = {}): AutomationInput => ({ name: '周报', prompt: '使用周报 Skill 读取已授权目录', enabled: true,
  timezone: 'Asia/Shanghai', schedule: { kind: 'interval', minutes: 60 }, ...patch });
let directory: string;
let now: number;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'todo-automation-')); now = Date.parse('2026-10-30T00:00:00Z'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('automation schedules', () => {
  it('defaults legacy definitions to Auto and validates explicit permission presets', () => {
    expect(validateAutomation(input(), now).permissionPreset).toBe('auto');
    expect(validateAutomation(input({ permissionPreset: 'danger-full-access' }), now).permissionPreset).toBe('danger-full-access');
    expect(() => validateAutomation(input({ permissionPreset: 'invented' as never }), now)).toThrow('权限预设');
  });
  it('computes calendar and Cron occurrences in the stored timezone', () => {
    const daily = input({ schedule: { kind: 'calendar', frequency: 'daily', time: '09:00' } });
    expect(new Date(nextRun(daily, now)).toISOString()).toBe('2026-10-30T01:00:00.000Z');
    const weekly = input({ schedule: { kind: 'calendar', frequency: 'weekly', time: '09:00', day: 1 } });
    expect(new Date(nextRun(weekly, now)).toISOString()).toBe('2026-11-02T01:00:00.000Z');
    const monthly = input({ schedule: { kind: 'calendar', frequency: 'monthly', time: '09:00', day: 31 } });
    expect(new Date(nextRun(monthly, Date.parse('2026-11-01T00:00:00Z'))).toISOString()).toBe('2026-12-31T01:00:00.000Z');
    expect(nextRun(input({ schedule: { kind: 'cron', expression: '0 9 * * 1-5' } }), now)).toBe(nextRun(daily, now));
  });

  it('handles daylight saving and rejects malformed or impossible schedules', () => {
    const daily = input({ timezone: 'America/New_York', schedule: { kind: 'calendar', frequency: 'daily', time: '09:00' } });
    expect(new Date(nextRun(daily, Date.parse('2026-03-08T05:00:00Z'))).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    for (const patch of [ { timezone: 'bad/timezone' }, { schedule: { kind: 'interval', minutes: 0 } },
      { schedule: { kind: 'cron', expression: '* * * * * *' } }, { schedule: { kind: 'cron', expression: '0 0 31 2 *' } },
      { schedule: { kind: 'calendar', frequency: 'weekly', time: '09:00', day: 9 } } ]) {
      expect(() => validateAutomation(input(patch as Partial<AutomationInput>), now)).toThrow();
    }
  });
});

describe('automation lifecycle', () => {
  const make = (execute = vi.fn(async () => ({ conversationId: 'real-conversation', content: '完成' })), ready = () => true) => {
    const scheduler = new AutomationScheduler(join(directory, 'ai-automations.json'), execute, ready, vi.fn(), () => now);
    return { scheduler, execute };
  };

  it('persists changes, rejects invalid edits atomically and supports pause/resume/delete', () => {
    const { scheduler } = make();
    const item = scheduler.save(input());
    expect(() => scheduler.save(input({ timezone: 'bad' }), item.id)).toThrow();
    expect(scheduler.snapshot().automations[0]).toEqual(item);
    scheduler.save(input({ enabled: false }), item.id);
    expect(make().scheduler.snapshot().automations[0].nextRunAt).toBeNull();
    scheduler.save(input(), item.id);
    expect(make().scheduler.snapshot().automations[0].enabled).toBe(true);
    scheduler.remove(item.id);
    expect(make().scheduler.snapshot().automations).toEqual([]);
  });

  it('executes a due occurrence once with results and a conversation reference', async () => {
    const { scheduler, execute } = make();
    const item = scheduler.save(input());
    now += 3600000;
    await scheduler.tick(); await flush(); await scheduler.tick();
    expect(execute).toHaveBeenCalledOnce();
    expect(scheduler.snapshot().runs[0]).toMatchObject({ automationId: item.id, status: 'succeeded', conversationId: 'real-conversation', result: '完成' });
    expect(make().scheduler.snapshot().runs[0].status).toBe('succeeded');
  });

  it('prevents overlap and marks in-flight runs interrupted after restart without replay', async () => {
    let finish!: (result: { conversationId: string; content: string }) => void;
    const execute = vi.fn(() => new Promise<{ conversationId: string; content: string }>((resolve) => { finish = resolve; }));
    const { scheduler } = make(execute);
    const item = scheduler.save(input());
    const running = scheduler.run(item.id);
    await expect(scheduler.run(item.id)).rejects.toThrow('正在执行');
    expect(() => scheduler.remove(item.id)).toThrow();
    now += 3600000;
    await scheduler.tick();
    expect(execute).toHaveBeenCalledOnce();
    const restarted = make();
    expect(restarted.scheduler.snapshot().runs[0].status).toBe('interrupted');
    await restarted.scheduler.tick();
    expect(restarted.execute).not.toHaveBeenCalled();
    finish({ conversationId: 'real', content: '完成' }); await running;
  });

  it('records failures and allows manual execution while paused', async () => {
    const { scheduler } = make(vi.fn(async () => { throw new Error('权限不足'); }));
    const item = scheduler.save(input({ enabled: false }));
    await scheduler.run(item.id);
    expect(scheduler.snapshot().runs[0]).toMatchObject({ status: 'failed', result: '权限不足' });
  });

  it('does not run before AI is ready or after stop and skips downtime', async () => {
    let ready = false;
    const { scheduler, execute } = make(undefined, () => ready);
    const item = scheduler.save(input());
    now += 3600000;
    await scheduler.tick();
    await expect(scheduler.run(item.id)).rejects.toThrow('尚未就绪');
    ready = true; now += 3600000;
    await scheduler.tick(); expect(execute).not.toHaveBeenCalled();
    expect(scheduler.snapshot().automations[0].nextRunAt).toBe(now + 3600000);
    now += 3600000; scheduler.stop(); await scheduler.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(directory, 'ai-automations.json'), 'utf8')).automations).toHaveLength(1);
  });
});
