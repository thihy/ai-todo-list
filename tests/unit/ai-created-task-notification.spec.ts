import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ supported: true, throwShow: false, notifications: [] as Array<any> }));
vi.mock('electron', () => ({ Notification: class {
  static isSupported() { return state.supported; }
  events: Record<string, (...args: any[]) => void> = {};
  constructor(public options: unknown) { state.notifications.push(this); }
  on(name: string, listener: (...args: any[]) => void) { this.events[name] = listener; }
  show() { if (state.throwShow) throw Error('OS unavailable'); }
} }));
vi.mock('../../src/main/logger', () => ({ logger: { warn: vi.fn() } }));
import { notifyAiCreatedTask, observeAiCreatedTasks } from '../../src/main/notification/ai-created-tasks';
const id = '01M3S5DX40SGT74QD9Q6VK5FEW';
const task = { id, title: '备份文件' };
beforeEach(() => { state.supported = true; state.throwShow = false; state.notifications.length = 0; });

describe('live AI creation results', () => {
  it('pairs native result with its call, verifies the real row and deduplicates repeated events', () => {
    const onCreated = vi.fn();
    const observe = observeAiCreatedTasks({ getTask: key => key === id ? task : null, onCreated });
    observe({ type: 'tool/call', data: { callId: 'call-1', name: 'todo_create' } });
    const event = { type: 'tool/result', data: { meta: task, message: { source: { callId: 'call-1' }, content: [{ isError: false }] } } };
    observe(event); observe(event);
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(task);
  });
  it('supports native rendered text and legacy results', () => {
    for (const data of [
      { name: 'todo_create', message: { content: [{ content: [{ type: 'text', text: JSON.stringify(task) }] }] } },
      { name: 'todo_create', result: task },
    ]) {
      const onCreated = vi.fn();
      observeAiCreatedTasks({ getTask: () => task, onCreated })({ type: 'tool/result', data });
      expect(onCreated).toHaveBeenCalledOnce();
      expect(onCreated).toHaveBeenCalledWith(task);
    }
  });
  it('ignores failed, missing, non-create and non-result events', () => {
    const onCreated = vi.fn();
    const observe = observeAiCreatedTasks({ getTask: () => null, onCreated });
    observe({ type: 'tool/result', data: { name: 'todo_create', result: task } });
    const exists = observeAiCreatedTasks({ getTask: () => task, onCreated });
    exists({ type: 'tool/result', data: { name: 'todo_update', result: task } });
    exists({ type: 'tool/result', data: { name: 'todo_create', result: task, error: 'failed' } });
    exists({ type: 'tool/result', data: { name: 'todo_create', meta: task, message: { content: [{ isError: true }] } } });
    exists({ type: 'assistant/chunk', data: { name: 'todo_create', result: task } });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('desktop notification', () => {
  it.each([false, true])('shows the task and automation source=%s, and opens its details only on click', automated => {
    const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } };
    notifyAiCreatedTask(task, () => window as any, automated);
    expect(state.notifications[0].options).toEqual({ title: automated ? '自动化新增任务' : 'AI 新增任务', body: task.title });
    expect(window.show).not.toHaveBeenCalled();
    state.notifications[0].events.click();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith('app:navigate', { route: `todo/${id}` });
  });
  it('does not fail AI work when the OS cannot show notifications', () => {
    state.supported = false;
    notifyAiCreatedTask(task, () => null, true);
    expect(state.notifications).toHaveLength(0);
    state.supported = true; state.throwShow = true;
    expect(() => notifyAiCreatedTask(task, () => null, true)).not.toThrow();
    expect(() => state.notifications[0].events.click()).not.toThrow();
  });
});
