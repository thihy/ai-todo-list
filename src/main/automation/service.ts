import { join } from 'node:path';
import { AutomationScheduler } from './scheduler';
import { register, okResult, failResult } from '../ipc/router';
import { startupState } from '../startup-state';
import { logger } from '../logger';
import type { ConversationRepo } from '../db/conversation-repo';
import { BrowserWindow } from 'electron';

let currentScheduler: AutomationScheduler | undefined;
export function getAutomationScheduler(): AutomationScheduler {
  if (!currentScheduler) throw new Error('自动化服务不可用');
  return currentScheduler;
}

export function registerAutomations(rootDir: string, conversations: ConversationRepo): () => void {
  let scheduler: AutomationScheduler | undefined;
  let loadError = '自动化尚未初始化';
  try {
    scheduler = new AutomationScheduler(join(rootDir, 'ai-automations.json'), async (item, reportConversation) => {
      const conversation = conversations.create({ title: `自动化 · ${item.name}` });
      reportConversation(conversation.id);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('app:data-changed', { scope: 'conversations' });
      }
      // Lazy import keeps AI boot out of the core startup path.
      const { askAi } = await import('../ipc/ai-handlers');
      const result = await askAi({ conversationId: conversation.id, prompt: item.prompt, intent: 'chat' });
      if (!result.ok) throw new Error(result.message);
      return { conversationId: conversation.id, content: result.data.content ?? '' };
    }, () => startupState.snapshot().ai.status === 'ready', (error) => logger.error(`automation: ${String(error)}`), Date.now, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('app:data-changed', { scope: 'automations' });
      }
    });
    scheduler.start();
    currentScheduler = scheduler;
  } catch (error) {
    loadError = `自动化数据无法加载：${error instanceof Error ? error.message : String(error)}`;
    logger.error(loadError);
  }
  register('automation.list', () => scheduler ? okResult(scheduler.snapshot()) : failResult('automation_unavailable', loadError));
  register('automation.save', (_event, req) => scheduler ? okResult(scheduler.save(req?.input, req?.id)) : failResult('automation_unavailable', loadError));
  register('automation.remove', (_event, req) => {
    if (!scheduler) return failResult('automation_unavailable', loadError);
    scheduler.remove(req?.id);
    return okResult(undefined);
  });
  register('automation.run', async (_event, req) => {
    if (!scheduler) return failResult('automation_unavailable', loadError);
    await scheduler.run(req?.id);
    return okResult(undefined);
  });
  return () => { scheduler?.stop(); if (currentScheduler === scheduler) currentScheduler = undefined; };
}
