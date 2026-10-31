import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), ask: vi.fn(), ready: true, send: vi.fn() }));
vi.mock('../../src/main/ipc/router', () => ({
  register: (name: string, fn: Function) => mocks.handlers.set(name, fn),
  okResult: (data: unknown) => ({ ok: true, data }),
  failResult: (code: string, message: string) => ({ ok: false, code, message }),
}));
vi.mock('../../src/main/startup-state', () => ({ startupState: { snapshot: () => ({ ai: { status: mocks.ready ? 'ready' : 'loading' } }) } }));
vi.mock('../../src/main/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../src/main/ipc/ai-handlers', () => ({ askAi: mocks.ask }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] } }));
import { registerAutomations } from '../../src/main/automation/service';
import { assistantToolDefinitions } from '../../src/main/automation/tools';

describe('automation AI integration', () => {
  let directory: string; let stop: () => void;
  const create = vi.fn();
  const call = (name: string, req?: unknown) => mocks.handlers.get(`automation.${name}`)!(undefined, req);
  beforeEach(() => {
    vi.clearAllMocks(); mocks.handlers.clear(); mocks.ready = true;
    directory = mkdtempSync(join(tmpdir(), 'automation-service-'));
    create.mockReturnValue({ id: 'database-generated-conversation' });
    setPermissionPreset.mockReturnValue(true);
    mocks.ask.mockResolvedValue({ ok: true, data: { content: '周报完成' } });
  });
  afterEach(() => { stop?.(); rmSync(directory, { recursive: true, force: true }); });
  const setPermissionPreset = vi.fn().mockReturnValue(true);
  const setup = () => { stop = registerAutomations(directory, { create, setPermissionPreset } as never); };
  const save = () => call('save', { input: { name: '周报', prompt: '使用周报 Skill 读取 D:\\Work\\Report.md', timezone: 'Asia/Shanghai', enabled: false,
    schedule: { kind: 'interval', minutes: 60 } } }).data;

  it('routes the saved instruction through the existing AI request implementation with a real conversation', async () => {
    setup(); const item = save();
    await call('run', { id: item.id });
    expect(create).toHaveBeenCalledWith({ title: '自动化 · 周报', automationId: item.id });
    expect(setPermissionPreset).toHaveBeenCalledWith('database-generated-conversation', 'auto');
    expect(mocks.ask).toHaveBeenCalledWith({ conversationId: 'database-generated-conversation', prompt: '使用周报 Skill 读取 D:\\Work\\Report.md', intent: 'chat' });
    expect(call('list').data.runs[0]).toMatchObject({ status: 'succeeded', result: '周报完成', conversationId: 'database-generated-conversation' });
    expect(mocks.send).toHaveBeenCalledWith('app:data-changed', { scope: 'conversations' });
    expect(mocks.send.mock.calls.filter(call => call[0] === 'app:data-changed' && call[1]?.scope === 'conversations')).toHaveLength(2);
  });

  it('uses the same scheduler for conversational tools and UI management', async () => {
    setup();
    const tools = assistantToolDefinitions();
    const saveTool = tools.find((tool) => tool.name === 'automation_save')!;
    const saved = await saveTool.execute({ name: '对话创建', prompt: '汇总今日待办', timezone: 'Asia/Shanghai', scheduleJson: '{"kind":"cron","expression":"0 9 * * 1-5"}', enabled: true } as never) as { id: string };
    expect(mocks.send).toHaveBeenCalledWith('app:data-changed', { scope: 'automations' });
    expect(call('list').data.automations).toEqual([expect.objectContaining({ id: saved.id, name: '对话创建' })]);
    mocks.send.mockClear();
    await saveTool.execute({ id: saved.id, name: '已修改', prompt: '整理今日未完成事项', timezone: 'Asia/Shanghai', scheduleJson: '{"kind":"interval","minutes":60}', enabled: false } as never);
    expect(mocks.send).toHaveBeenCalledWith('app:data-changed', { scope: 'automations' });
    expect(call('list').data.automations[0]).toMatchObject({ id: saved.id, name: '已修改', enabled: false, prompt: '整理今日未完成事项' });
    mocks.send.mockClear();
    await tools.find((tool) => tool.name === 'automation_remove')!.execute({ id: saved.id } as never);
    expect(mocks.send).toHaveBeenCalledWith('app:data-changed', { scope: 'automations' });
    expect(call('list').data.automations).toHaveLength(0);
  });

  it.each(['auto', 'read-only', 'workspace-write', 'danger-full-access'])('pins %s before starting the AI', async permissionPreset => {
    setup(); const base = save();
    const item = call('save', { id: base.id, input: { ...base, permissionPreset } }).data;
    mocks.ask.mockImplementation(async () => {
      expect(setPermissionPreset).toHaveBeenCalledWith('database-generated-conversation', permissionPreset);
      return { ok: true, data: { content: 'done' } };
    });
    await call('run', { id: item.id });
    expect(call('list').data.runs[0].status).toBe('succeeded');
  });

  it('does not start AI when permission application fails', async () => {
    setup(); const item = save(); setPermissionPreset.mockReturnValue(false);
    await call('run', { id: item.id });
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(call('list').data.runs[0]).toMatchObject({ status: 'failed', conversationId: 'database-generated-conversation' });
  });

  it('stays running until the AI result arrives and then publishes completed history', async () => {
    setup(); const item = save();
    let finish!: (value: unknown) => void;
    mocks.ask.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const running = call('run', { id: item.id });
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
    expect(call('list').data.runs[0]).toMatchObject({ status: 'running' });
    expect(mocks.send.mock.calls.filter(call => call[1]?.scope === 'conversations')).toHaveLength(1);
    finish({ ok: true, data: { content: 'AI 实际执行完成' } });
    await running;
    expect(call('list').data.runs[0]).toMatchObject({ status: 'succeeded', result: 'AI 实际执行完成' });
    expect(mocks.send.mock.calls.filter(call => call[1]?.scope === 'conversations')).toHaveLength(2);
  });

  it('preserves the conversation reference and records an AI failure', async () => {
    setup(); const item = save(); mocks.ask.mockResolvedValue({ ok: false, message: '请设置 API Key' });
    await call('run', { id: item.id });
    expect(call('list').data.runs[0]).toMatchObject({ status: 'failed', result: '请设置 API Key', conversationId: 'database-generated-conversation' });
    expect(mocks.send.mock.calls.filter(call => call[0] === 'app:data-changed' && call[1]?.scope === 'conversations')).toHaveLength(2);
  });
  it('does not announce a catalog change when a tool rejects invalid input', async () => {
    setup(); mocks.send.mockClear();
    await expect(assistantToolDefinitions().find((tool) => tool.name === 'automation_save')!.execute({ name: '无效', prompt: '整理任务', timezone: 'invalid', scheduleJson: '{"kind":"interval","minutes":60}', enabled: true } as never)).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(call('list').data.automations).toHaveLength(0);
  });

  it('reports malformed saved data without overwriting it or starting AI', () => {
    writeFileSync(join(directory, 'ai-automations.json'), '{broken'); setup();
    expect(call('list')).toMatchObject({ ok: false, code: 'automation_unavailable' });
    expect(mocks.ask).not.toHaveBeenCalled();
  });
});
