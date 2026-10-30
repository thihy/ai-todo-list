import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

test('compact mode stays small and on top, completes real tasks and returns to detail', async () => {
  const handle = await launchApp();
  try {
    const ids = await handle.win.evaluate(async () => {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const ids: string[] = [];
      for (const [index, title] of ['今日最先', '今日稍后', '其他紧急', '无日期一', '无日期二', '无日期三'].entries()) {
        const result = await window.todoList.todo.create({ title, plannedFor: index < 2 ? today : null,
          dueAt: index < 3 ? Date.now() + (index + 1) * 86400000 : null });
        if (!result.ok) throw new Error(result.message);
        ids.push(result.data.id);
      }
      return ids;
    });
    await expect(handle.win.getByRole('button', { name: '精简悬浮模式' })).toBeVisible();
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const created = handle.app.waitForEvent('window');
    await handle.win.getByRole('button', { name: '精简悬浮模式' }).click();
    const compact = await created;
    await expect(compact.getByRole('main', { name: '精简待办' })).toBeVisible();
    await expect(compact.locator('.compact-view__row')).toHaveCount(5);
    await compact.screenshot({ path: test.info().outputPath('compact-mode.png') });
    await expect(compact.locator('.compact-view__title').first()).toHaveText('今日最先');
    const state = await handle.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#/compact'))!;
      return { bounds: window.getBounds(), onTop: window.isAlwaysOnTop(), resizable: window.isResizable() };
    });
    // Windows may add a few DIP of non-client frame at fractional display scale.
    expect(state.bounds.width).toBeGreaterThanOrEqual(240); expect(state.bounds.width).toBeLessThanOrEqual(256);
    expect(state.bounds.height).toBeLessThanOrEqual(190);
    expect(state.onTop).toBe(true); expect(state.resizable).toBe(false);
    await compact.getByRole('button', { name: '完成 今日最先', exact: true }).click();
    await expect(compact.locator('.compact-view__title')).not.toContainText(['今日最先']);
    await expect(compact.locator('.compact-view__row')).toHaveCount(5);
    const result = await handle.win.evaluate((id) => window.todoList.todo.get(id), ids[0]!);
    expect(result.ok && result.data?.status).toBe('done');
    await compact.getByRole('button', { name: /^今日稍后/ }).click();
    await expect.poll(() => handle.win.evaluate(() => location.hash)).toBe(`#/todo/${ids[1]}`);
    // Re-entry uses the same floating window and keeps its state.
    await handle.win.getByRole('button', { name: '精简悬浮模式' }).click();
    await expect(compact.getByRole('main', { name: '精简待办' })).toBeVisible();
    expect(await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('#/compact')).length)).toBe(1);
    // Main-window changes also reach the floating list.
    await handle.win.evaluate(async (ids) => { for (const id of ids) await window.todoList.todo.update(id, { status: 'done' }); }, ids);
    await expect(compact.getByText('暂时没有待办，轻松一下。')).toBeVisible();
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getBounds().height)).toBeLessThan(100);
    await compact.getByRole('button', { name: '展开主窗口' }).click();
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('#/todo/'))?.isVisible())).toBe(true);
  } finally { await handle.app.close(); }
});
