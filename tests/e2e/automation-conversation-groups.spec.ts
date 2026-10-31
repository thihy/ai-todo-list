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
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const result = await window.todoList.automation.save({ name: '同名自动化', prompt: '列出今日事项', enabled: false, timezone: 'Asia/Shanghai', schedule: { kind: 'interval', minutes: 60 } });
        if (!result.ok) throw new Error(result.message); ids.push(result.data.id);
      }
      return ids;
    });
    await handle.win.reload(); await openAiPane(handle.win);
    await handle.win.getByRole('button', { name: '对话历史', exact: true }).click();
    const groups = handle.win.locator('.aipane__conversation-group');
    await expect(groups).toHaveCount(3);
    await expect(groups.filter({ hasText: '同名自动化' })).toHaveCount(2);
    const automated = groups.filter({ hasText: '同名自动化' }).first();
    await automated.locator('summary').click();
    await expect(automated).toContainText('自动管理');
    await expect(automated.getByRole('button')).toHaveCount(0);
    await handle.win.evaluate(async id => { const snapshot = await window.todoList.automation.list(); if (!snapshot.ok) throw Error(snapshot.message); const item = snapshot.data.automations.find(row => row.id === id)!; await window.todoList.automation.save({ ...item, name: '改名后的任务' }, id); }, ids[0]!);
    await expect(groups.filter({ hasText: '改名后的任务' })).toHaveCount(1);
    await handle.win.evaluate(id => window.todoList.automation.remove(id), ids[0]!);
    await expect(groups).toHaveCount(2);
    await expect(groups.filter({ hasText: '普通验证对话' })).toHaveCount(1);
    await handle.win.screenshot({ path: test.info().outputPath('conversation-groups.png') });
  } finally { await handle.app.close(); }
});
