import { Notification, type BrowserWindow } from 'electron';
import { extractCreatedTodoId } from '../../shared/ai-created-todo';
import { logger } from '../logger';

type CreatedTask = { id: string; title: string };

/** One observer per live AI invocation. Never invoked when replaying history. */
export function observeAiCreatedTasks(deps: {
  getTask(id: string): CreatedTask | null | undefined;
  onCreated(task: CreatedTask): void;
}): (event: { type: string; data?: unknown }) => void {
  const calls = new Map<string, string>();
  const seen = new Set<string>();
  return event => {
    const data = event.data as {
      name?: string; callId?: string; error?: unknown; result?: unknown; meta?: unknown;
      message?: { source?: { callId?: string }; content?: Array<{ isError?: boolean; content?: unknown[] }> };
    } | undefined;
    if (!data) return;
    if (event.type === 'tool/call') {
      if (data.callId && data.name) calls.set(String(data.callId), data.name);
      return;
    }
    if (event.type !== 'tool/result') return;
    const callId = data.message?.source?.callId ?? data.callId;
    const name = (callId ? calls.get(String(callId)) : undefined) ?? data.name;
    const blocks = data.message?.content;
    if (name !== 'todo_create' || data.error || blocks?.some(block => block.isError)) return;
    let id = extractCreatedTodoId(data.meta) ?? extractCreatedTodoId(data.result);
    if (!id) {
      for (const block of blocks ?? []) {
        for (const content of block.content ?? []) {
          const text = content as { type?: string; text?: string };
          if (text.type === 'text') id = extractCreatedTodoId(text.text);
          if (id) break;
        }
        if (id) break;
      }
    }
    if (!id || seen.has(id)) return;
    const task = deps.getTask(id);
    if (!task) return;
    seen.add(id);
    deps.onCreated(task);
  };
}

/** A failed or unsupported OS notification must never fail an AI turn. */
export function notifyAiCreatedTask(task: CreatedTask, getMainWindow: () => BrowserWindow | null, automated: boolean): void {
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: automated ? '自动化新增任务' : 'AI 新增任务',
      body: task.title,
    });
    notification.on('click', () => {
      try {
        const window = getMainWindow();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send('app:navigate', { route: `todo/${task.id}` });
      } catch (error) { logger.warn(`AI task notification click failed: ${String(error)}`); }
    });
    notification.on('failed', (_event, error) => logger.warn(`AI task notification failed: ${String(error)}`));
    notification.show();
  } catch (error) { logger.warn(`AI task notification unavailable: ${String(error)}`); }
}
