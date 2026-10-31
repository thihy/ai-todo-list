import { test, expect } from '@playwright/test';
import { launchApp, openAiPane } from './helpers';

test('automation groups follow catalog lifecycle without independent editing or deletion', async () => {
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    const ids = await handle.win.evaluate(async () => {
      const conversation = await window.todoList.conversation.create({ title: '普通验证对话' });
      if (!conversation.ok) throw new Error(conversation.message);
      await window.todoList.settings.set({ provider: 'ollama' });
      const answer = await window.todoList.ai.ask({ conversationId: conversation.data.conversation.id, prompt: '/help' });
      if (!answer.ok) throw new Error(answer.message);
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const result = await window.todoList.automation.save({ name: '同名自动化', prompt: '列出今日事项', enabled: false, timezone: 'Asia/Shanghai', schedule: { kind: 'interval', minutes: 60 } });
        if (!result.ok) throw new Error(result.message); ids.push(result.data.id);
      }
      for (let i = 0; i < 2; i++) {
        const snapshot = await window.todoList.automation.list(); if (!snapshot.ok) throw new Error(snapshot.message);
        const item = snapshot.data.automations.find(item => item.id === ids[0])!;
        await window.todoList.automation.save({ ...item, prompt: '/help' }, item.id);
        const result = await window.todoList.automation.run(item.id); if (!result.ok) throw new Error(result.message);
      }
      return ids;
    });
    await handle.win.reload(); await openAiPane(handle.win);
    await handle.win.getByRole('button', { name: '对话历史', exact: true }).click();
    const groups = handle.win.locator('.aipane__conversation-group');
    await expect(groups).toHaveCount(3);
    await expect(handle.win.locator('.history-time').first()).toBeVisible();
    await expect(handle.win.locator('.aipane__menu-preview').first()).toBeVisible();
    await handle.win.getByRole('searchbox', { name: '搜索对话' }).fill('/help');
    await expect(groups.filter({ hasText: '普通验证对话' })).toHaveCount(1);
    await handle.win.getByRole('searchbox', { name: '搜索对话' }).fill('');
    await expect(groups.filter({ hasText: '同名自动化' })).toHaveCount(2);
    const automated = handle.win.locator(`[data-automation-id="${ids[0]}"]`);
    if (await automated.getAttribute('open') === null) await automated.locator('summary').click();
    await expect(automated).toContainText('自动管理');
    await expect(automated.locator('summary').getByRole('button')).toHaveCount(0);
    await expect(automated.locator('.history-run-state')).toHaveCount(2);
    await expect(automated.locator('.history-run-state').first()).toHaveText('已完成');
    await expect(automated.locator('.history-run-state').first()).toBeVisible();
    await handle.win.screenshot({ path: test.info().outputPath('history-popover-implemented.png') });
    await handle.win.evaluate(async id => { const snapshot = await window.todoList.automation.list(); if (!snapshot.ok) throw Error(snapshot.message); const item = snapshot.data.automations.find(row => row.id === id)!; await window.todoList.automation.save({ ...item, name: '改名后的任务' }, id); }, ids[0]!);
    await expect(groups.filter({ hasText: '改名后的任务' })).toHaveCount(1);
    await handle.win.evaluate(id => window.todoList.automation.remove(id), ids[0]!);
    await expect(groups).toHaveCount(2);
    const retained = await handle.win.evaluate(async id => { const result = await window.todoList.conversation.list({ limit: 50 }); return result.ok ? result.data.conversations.filter(row => row.automationId === id).length : -1; }, ids[0]!);
    expect(retained).toBe(2);
    await expect(groups.filter({ hasText: '普通验证对话' })).toHaveCount(1);
    await handle.win.screenshot({ path: test.info().outputPath('conversation-groups.png') });
  } finally { await handle.app.close(); }
});
