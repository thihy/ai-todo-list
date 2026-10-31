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
    const section = handle.win.locator('.task-extra-info');
    await expect(section.getByRole('heading', { name: '附加' })).toBeVisible({ timeout: 10000 });
    const sectionTitles = await handle.win.locator('.editor-pane__scroll .editor-pane__section-title').allTextContents();
    expect(sectionTitles.indexOf('附加')).toBeGreaterThan(sectionTitles.indexOf('附件'));
    expect(sectionTitles.indexOf('附加')).toBeLessThan(sectionTitles.indexOf('文档'));
    await section.getByRole('button', { name: '添加', exact: true }).click();
    const form = handle.win.getByRole('form', { name: '任务元数据' });
    await form.getByRole('button', { name: '添加字段', exact: true }).click();
    await form.getByLabel('元数据键 1', { exact: true }).fill('外部编号');
    await form.getByLabel('元数据值 1', { exact: true }).fill('000123');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.todo.get(id), id); return result.ok ? result.data?.metadata : null; }).toEqual({ 外部编号: '000123' });
    await expect(form).toHaveCount(0);
    await expect(section).toContainText('外部编号=000123');
    await section.screenshot({ path: test.info().outputPath('additional-info-one-line.png') });
    await handle.win.screenshot({ path: test.info().outputPath('additional-section-position.png') });
    await section.getByRole('button', { name: '编辑', exact: true }).click();
    await form.getByRole('button', { name: '添加字段', exact: true }).click();
    await form.getByLabel('元数据键 2', { exact: true }).fill('外部编号');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toContainText('元数据键不能重复');
    await form.getByLabel('删除元数据 2', { exact: true }).click();
    await form.getByLabel('删除元数据 1', { exact: true }).click();
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.todo.get(id), id); return result.ok ? result.data?.metadata : null; }).toEqual({});
    await handle.win.evaluate(id => window.todoList.todo.update(id, { metadata: { 说明: '长内容'.repeat(100) } }), id);
    await expect(section.getByRole('button', { name: '更多', exact: true })).toBeVisible();
    await section.getByRole('button', { name: '更多', exact: true }).click();
    await expect(section.locator('.task-extra-info__values')).toHaveClass(/is-expanded/);
    await section.getByRole('button', { name: '收起', exact: true }).click();
    await expect(section.locator('.task-extra-info__values')).not.toHaveClass(/is-expanded/);
  } finally { await handle.app.close(); }
});
