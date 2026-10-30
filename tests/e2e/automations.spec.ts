import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('an open automation list immediately reflects external catalog writes without manual refresh', async () => {
  const handle = await launchApp();
  try {
    await handle.win.evaluate(() => { location.hash = '/ai'; });
    await handle.win.getByRole('button', { name: '自动化', exact: true }).click();
    const panel = handle.win.getByRole('dialog', { name: '自动化管理' });
    await expect(panel.locator('article')).toHaveCount(0);
    const id = await handle.win.evaluate(async () => {
      const result = await window.todoList.automation.save({ name: '对话工具共享目录检查', prompt: '按优先级整理今日待办', timezone: 'Asia/Shanghai', enabled: false, schedule: { kind: 'interval', minutes: 120 } });
      if (!result.ok) throw new Error(result.message);
      return result.data.id;
    });
    // This bypasses pane actions: only the main-process change event can update it within 2s.
    await expect(panel.locator('article')).toContainText('对话工具共享目录检查', { timeout: 2000 });
    await expect(panel.locator('article')).toContainText('按优先级整理今日待办');
    await handle.win.evaluate(async (id) => {
      const result = await window.todoList.automation.save({ name: '已从共享目录更新', prompt: '整理未完成事项和截止日期', timezone: 'Asia/Shanghai', enabled: true, schedule: { kind: 'interval', minutes: 120 } }, id);
      if (!result.ok) throw new Error(result.message);
    }, id);
    await expect(panel.locator('article')).toContainText('已从共享目录更新', { timeout: 2000 });
    await expect(panel.getByRole('switch', { name: '禁用 已从共享目录更新', exact: true })).toBeVisible();
    await handle.win.evaluate(async (id) => {
      const result = await window.todoList.automation.remove(id);
      if (!result.ok) throw new Error(result.message);
    }, id);
    await expect(panel.locator('article')).toHaveCount(0, { timeout: 2000 });
  } finally { await handle.app.close(); }
});

test('automation popover manages persistent schedules through real IPC', async () => {
  const handle = await launchApp();
  try {
    await handle.win.waitForFunction(() => !!window.todoList?.automation);
    await handle.win.evaluate(() => { location.hash = '/ai'; });
    await handle.win.getByRole('button', { name: '自动化', exact: true }).click();
    const settings = handle.win.getByRole('dialog', { name: '自动化管理', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '手动创建', exact: true }).click();
    await settings.getByLabel('名称', { exact: true }).fill('自动化集成检查');
    await settings.getByRole('textbox', { name: '任务描述 / 执行指令', exact: true }).fill('使用周报 Skill 读取已授权的报告目录。');
    await settings.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
    // Keep this a configuration test: never call a real provider.
    await settings.getByLabel('启用自动触发').uncheck();
    await settings.getByRole('combobox', { name: '执行时间', exact: true }).selectOption('cron');
    await settings.getByLabel('Cron 表达式').fill('0 9 * * 1-5');
    await settings.getByRole('button', { name: '创建自动化' }).click();
    await expect(settings.locator('article')).toHaveCount(1);
    await expect(settings.locator('article')).toContainText('已禁用');
    await expect(settings.locator('article')).toContainText('工作日 09:00');
    const saved = await handle.win.evaluate(() => window.todoList.automation.list());
    expect(saved.ok && saved.data.automations[0]).toMatchObject({ name: '自动化集成检查', enabled: false,
      schedule: { kind: 'cron', expression: '0 9 * * 1-5' } });
    expect(JSON.parse(readFileSync(join(handle.dataDir, 'ai-automations.json'), 'utf8')).automations).toHaveLength(1);
    await settings.getByRole('button', { name: '编辑', exact: true }).click();
    await settings.getByRole('combobox', { name: '执行时间', exact: true }).selectOption('interval');
    await settings.getByLabel('间隔（分钟）').fill('120');
    await settings.getByRole('button', { name: '保存修改' }).click();
    await settings.screenshot({ path: test.info().outputPath('ai-automations.png') });
    await settings.getByRole('switch', { name: '启用 自动化集成检查', exact: true }).click();
    await expect(settings.locator('article')).toContainText('下次执行');
    await settings.getByRole('switch', { name: '禁用 自动化集成检查', exact: true }).click();
    await expect(settings.locator('article')).toContainText('已禁用');
    await settings.getByRole('button', { name: '删除', exact: true }).click();
    await expect(settings.locator('article')).toHaveCount(0);
  } finally { await handle.app.close(); }
});
