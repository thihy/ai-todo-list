import { test, expect } from '@playwright/test';
import { launchApp, openAiPane } from './helpers';

test('assistant exposes focused panels and native slash commands', async () => {
  test.setTimeout(90000);
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await handle.win.getByRole('button', { name: '自动化', exact: true }).click();
    const automations = handle.win.getByRole('dialog', { name: '自动化管理' });
    await expect(automations).toBeVisible();
    await expect(automations.getByRole('button', { name: '通过对话创建' })).toBeVisible();
    await expect(automations.locator('form')).toHaveCount(0);
    await automations.screenshot({ path: test.info().outputPath('automations-panel.png') });
    await automations.getByRole('button', { name: '通过对话创建' }).click();
    await expect(automations).toHaveCount(0);
    await expect(handle.win.getByRole('textbox', { name: '向 AI 提问' })).toHaveValue(/每个工作日/);
    await handle.win.getByRole('button', { name: '技能', exact: true }).click();
    const skills = handle.win.getByRole('dialog', { name: '技能管理' });
    await expect(skills).toBeVisible();
    await expect(skills.getByRole('button', { name: '安装技能' })).toBeVisible();
    await skills.getByRole('button', { name: '关闭管理面板' }).click();
    // Only configure a local endpoint: /help and /compact must never issue a model request.
    await handle.win.evaluate(() => window.todoList.settings.set({ provider: 'ollama' }));
    await expect.poll(async () => {
      const result = await handle.win.evaluate(() => window.todoList.skill.commands());
      return result.ok ? result.data.map((item) => item.name) : [];
    }, { timeout: 60000 }).toContain('compact');
    const input = handle.win.getByRole('textbox', { name: '向 AI 提问' });
    await input.fill('/');
    await expect(input).toHaveValue('/');
    const menu = handle.win.getByRole('listbox', { name: '系统命令' });
    await expect(menu.getByRole('option').filter({ hasText: '/compact' })).toBeVisible();
    await menu.screenshot({ path: test.info().outputPath('slash-commands.png') });
    await input.fill('/sk'); await input.press('Tab');
    await expect(input).toHaveValue('/skills');
    await input.press('Enter'); await expect(skills).toBeVisible();
    await expect(skills.getByText('正在读取技能…')).toHaveCount(0, { timeout: 15000 });
    await skills.screenshot({ path: test.info().outputPath('skills-panel.png') });
    await skills.getByRole('button', { name: '关闭管理面板' }).click();
    const results = await handle.win.evaluate(async () => {
      const created = await window.todoList.conversation.create({ title: '命令集成检查' });
      if (!created.ok) throw new Error(created.message);
      const id = created.data.conversation.id;
      const help = await window.todoList.ai.ask({ conversationId: id, prompt: '/help' });
      const compact = await window.todoList.ai.ask({ conversationId: id, prompt: '/compact' });
      const unknown = await window.todoList.ai.ask({ conversationId: id, prompt: '/not-a-real-command' });
      return { help, compact, unknown };
    });
    expect(results.help.ok && results.help.data.content).toContain('/compact');
    expect(results.help.ok && results.help.data.tokensOut).toBe(0);
    expect(results.compact.ok && results.compact.data.content).toContain('No compactable history');
    expect(results.unknown.ok).toBe(false);
    if (!results.unknown.ok) expect(results.unknown.message).toContain('未知系统命令');
  } finally { await handle.app.close(); }
});
