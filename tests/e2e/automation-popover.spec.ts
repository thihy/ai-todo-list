import { test, expect } from '@playwright/test';
import { launchApp, openAiPane } from './helpers';

test('automation popover matches the compact list and contextual editor design', async () => {
  test.setTimeout(60000);
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await handle.win.evaluate(async () => {
      const samples = [
        { name: '每日待办整理', prompt: '查询今日待办，按优先级整理未完成事项，并生成简短的今日行动清单。', enabled: true, schedule: { kind: 'calendar' as const, frequency: 'daily' as const, time: '09:00' } },
        { name: '每周工作回顾', prompt: '汇总本周完成事项与待跟进问题。', enabled: true, schedule: { kind: 'calendar' as const, frequency: 'weekly' as const, time: '18:00', day: 5 } },
        { name: '资料目录检查', prompt: '检查指定目录并报告新增或变更文件。', enabled: false, schedule: { kind: 'interval' as const, minutes: 120 } },
      ];
      for (const item of samples) {
        const result = await window.todoList.automation.save({ ...item, timezone: 'Asia/Shanghai' });
        if (!result.ok) throw new Error(result.message);
      }
    });
    const trigger = handle.win.getByRole('button', { name: '自动化', exact: true });
    const panel = handle.win.getByRole('dialog', { name: '自动化管理' });
    await trigger.click();
    await expect(panel).toHaveAttribute('aria-modal', 'false');
    await expect(panel.locator('article')).toHaveCount(3);
    await expect(panel.locator('form')).toHaveCount(0);
    const box = await panel.boundingBox(); const anchor = await trigger.boundingBox();
    expect(box!.y).toBeGreaterThan(anchor!.y + anchor!.height);
    expect(box!.width).toBeLessThanOrEqual(422);
    await handle.win.screenshot({ path: test.info().outputPath('automation-popover-list.png') });
    await panel.screenshot({ path: test.info().outputPath('automation-list-detail.png') });
    const disabled = panel.locator('article').filter({ hasText: '资料目录检查' });
    await expect(disabled).toContainText('已禁用');
    await expect(disabled).not.toContainText('下次执行');
    await disabled.getByRole('switch').click();
    await expect(disabled.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await disabled.getByRole('switch').click();
    await expect(disabled.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const daily = panel.locator('article').filter({ hasText: '每日待办整理' });
    await daily.getByRole('button', { name: '编辑', exact: true }).click();
    const instruction = panel.getByRole('textbox', { name: '任务描述 / 执行指令' });
    await expect(instruction).toBeVisible();
    await expect(instruction).toHaveValue(/查询今日待办/);
    const permissionPreset = panel.getByLabel('自动化执行权限', { exact: true });
    await expect(permissionPreset).toHaveValue('auto');
    await permissionPreset.selectOption('read-only');
    await instruction.fill('');
    await expect(panel.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    await instruction.fill('整理今日未完成任务，列出临近截止事项，并生成一份行动清单。');
    await handle.win.screenshot({ path: test.info().outputPath('automation-popover-editor.png') });
    await panel.screenshot({ path: test.info().outputPath('automation-editor-detail.png') });
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(daily).toContainText('整理今日未完成任务');
    await expect(daily).toContainText('执行权限：只读');
    await panel.getByRole('button', { name: '查看运行记录 →' }).click();
    await expect(panel).toContainText('暂无执行记录');
    await panel.getByRole('button', { name: '运行记录', exact: true }).click();
    await handle.win.locator('.aipane__brand-text').click();
    await expect(panel).toHaveCount(0);
    await trigger.click(); await handle.win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await trigger.click(); await expect(panel).toHaveCount(0);
    const permission = handle.win.getByRole('button', { name: 'AI 权限预设', exact: true });
    await expect(permission).toBeVisible({ timeout: 20000 });
    expect(await permission.evaluate((element) => !!element.closest('.aipane__composer-tools'))).toBe(true);
    expect(await handle.win.locator('.aipane__title [aria-label="AI 权限预设"]').count()).toBe(0);
    await permission.click();
    await expect(handle.win.getByRole('listbox').filter({ hasText: '权限预设' })).toBeVisible();
    await handle.win.screenshot({ path: test.info().outputPath('composer-permission-menu.png') });
    await permission.click();
    await trigger.click();
    await panel.locator('article').filter({ hasText: '每周工作回顾' }).getByRole('button', { name: '删除', exact: true }).click();
    await expect(panel.locator('article')).toHaveCount(2);
    await handle.win.setViewportSize({ width: 900, height: 620 });
    await expect.poll(async () => {
      if (!await panel.count()) return true; // Responsive collapse can hide the trigger and close its popover.
      const bounds = await panel.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 900 && bounds.y + bounds.height <= 620;
    }).toBe(true);
    await handle.win.screenshot({ path: test.info().outputPath('automation-popover-narrow.png') });
    await handle.win.evaluate(() => { location.hash = '/settings'; });
    const settings = handle.win.getByRole('dialog', { name: '设置', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: 'AI 自动化', exact: true })).toHaveCount(0);
  } finally { await handle.app.close(); }
});
