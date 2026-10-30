// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsPane } from '../../src/renderer/components/AutomationsPane';
import type { Automation } from '../../src/shared/automation-types';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('automation management', () => {
  let host: HTMLDivElement; let root: Root;
  const item: Automation = { id: 'saved', name: '周报', prompt: '汇总进展', timezone: 'Asia/Shanghai', enabled: true,
    schedule: { kind: 'interval', minutes: 60 }, createdAt: 0, nextRunAt: 3600000 };
  const list = vi.fn(); const save = vi.fn(); const remove = vi.fn(); const run = vi.fn();
  const listeners = new Set<(event: { scope: string }) => void>();
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    list.mockResolvedValue({ ok: true, data: { automations: [item], runs: [] } });
    save.mockResolvedValue({ ok: true, data: item }); remove.mockResolvedValue({ ok: true }); run.mockResolvedValue({ ok: true });
    (window as any).todoList = { automation: { list, save, remove, run }, on: (_event: string, listener: (event: { scope: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<AutomationsPane />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  it('pauses the saved record and executes the real automation id', async () => {
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), 'saved');
    await act(async () => (host.querySelector('[aria-label="立即执行 周报"]') as HTMLButtonElement).click());
    expect(run).toHaveBeenCalledWith('saved');
  });
  it('immediately refreshes conversation-created, edited and removed definitions on committed changes', async () => {
    list.mockResolvedValue({ ok: true, data: { automations: [{ ...item, name: '对话中创建的计划', prompt: '实际执行指令', enabled: false }], runs: [] } });
    await act(async () => { for (const listener of listeners) listener({ scope: 'automations' }); });
    expect(host.querySelector('article')!.textContent).toContain('对话中创建的计划');
    expect(host.querySelector('article')!.textContent).toContain('实际执行指令');
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('article')!.textContent).not.toContain('下次执行');
    list.mockResolvedValue({ ok: true, data: { automations: [], runs: [] } });
    await act(async () => { for (const listener of listeners) listener({ scope: 'automations' }); });
    expect(host.querySelector('article')).toBeNull();
  });
  it('ignores a stale response which resolves after a newer change notification', async () => {
    let finish!: (value: unknown) => void;
    list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { for (const listener of listeners) listener({ scope: 'automations' }); });
    list.mockResolvedValue({ ok: true, data: { automations: [], runs: [] } });
    await act(async () => { for (const listener of listeners) listener({ scope: 'automations' }); });
    await act(async () => { finish({ ok: true, data: { automations: [item], runs: [] } }); });
    expect(host.querySelector('article')).toBeNull();
  });
  it('loads an existing definition into the editor and preserves it after a failed save', async () => {
    await act(async () => button('编辑').click());
    expect(host.querySelector('textarea')!.value).toBe('汇总进展');
    save.mockResolvedValueOnce({ ok: false, message: '时区无效' });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: '周报' }), 'saved');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('时区无效');
    expect(host.querySelector('textarea')!.value).toBe('汇总进展');
  });
  it('shows history failures and blocks actions for a running automation', async () => {
    list.mockResolvedValue({ ok: true, data: { automations: [item], runs: [
      { id: 'running', automationId: 'saved', name: '周报', status: 'running', startedAt: 0 },
      { id: 'failed', automationId: 'saved', name: '周报', status: 'failed', startedAt: 0, result: '权限不足' },
    ] } });
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<AutomationsPane />); });
    expect((host.querySelector('[aria-label="执行中…"]') as HTMLButtonElement).disabled).toBe(true);
    expect(button('删除').disabled).toBe(true);
    await act(async () => button('查看运行记录 →').click());
    expect(host.textContent).toContain('权限不足');
  });
  it('requires a complete execution instruction and returns from editing without changing the catalog', async () => {
    await act(async () => button('新建').click());
    const instruction = host.querySelector('textarea')!;
    expect(instruction.required).toBe(true);
    expect(instruction.getAttribute('aria-label')).toBe('任务描述 / 执行指令');
    expect(button('创建自动化').disabled).toBe(true);
    await act(async () => button('取消').click());
    expect(host.querySelector('form')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
