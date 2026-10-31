import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

test('task custom KV metadata persists, validates duplicates and supports removal', async () => {
  const handle = await launchApp();
  try {
    handle.win.on('pageerror', error => console.error('Metadata renderer error:', error));
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible();
    const id = await handle.win.evaluate(async () => {
      const result = await window.todoList.todo.create({ title: '元数据验证' }); if (!result.ok) throw Error(result.message); return result.data.id;
    });
    await handle.win.evaluate(id => { location.hash = '#/todo/' + id; }, id);
    await expect(handle.win.locator('summary').filter({ hasText: '自定义信息' })).toBeVisible({ timeout: 10000 });
    await handle.win.locator('summary').filter({ hasText: '自定义信息' }).click();
    const form = handle.win.getByRole('form', { name: '任务元数据' });
    await form.getByRole('button', { name: '添加字段', exact: true }).click();
    await form.getByLabel('元数据键 1', { exact: true }).fill('外部编号');
    await form.getByLabel('元数据值 1', { exact: true }).fill('000123');
    await form.getByRole('button', { name: '保存元数据', exact: true }).click();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.todo.get(id), id); return result.ok ? result.data?.metadata : null; }).toEqual({ 外部编号: '000123' });
    await form.getByRole('button', { name: '添加字段', exact: true }).click();
    await form.getByLabel('元数据键 2', { exact: true }).fill('外部编号');
    await form.getByRole('button', { name: '保存元数据', exact: true }).click();
    await expect(form).toContainText('元数据键不能重复');
    await form.getByLabel('删除元数据 2', { exact: true }).click();
    await form.getByLabel('删除元数据 1', { exact: true }).click();
    await form.getByRole('button', { name: '保存元数据', exact: true }).click();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.todo.get(id), id); return result.ok ? result.data?.metadata : null; }).toEqual({});
  } finally { await handle.app.close(); }
});
