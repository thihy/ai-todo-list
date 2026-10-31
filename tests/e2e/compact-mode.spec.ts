import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('floating task menu updates priority, status and progress, and can be disabled', async () => {
  const handle = await launchApp();
  try {
    await handle.win.evaluate(async () => { const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; await window.todoList.todo.create({ title: '悬浮任务操作测试', priority: 'high', plannedFor: today }); await window.todoList.app.compactConfigure({ enabled: true }); });
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const page = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
    const task = page.getByRole('button', { name: /^悬浮任务操作测试/ });
    await expect(task).toBeVisible();
    await expect(page.locator('.priority-high .compact-view__title')).toHaveText('悬浮任务操作测试');
    await task.click({ button: 'right' });
    await page.getByLabel('修改优先级').selectOption('very-high');
    await expect(page.locator('.priority-very-high .compact-view__title')).toHaveText('悬浮任务操作测试');
    await task.click({ button: 'right' }); await page.getByRole('button', { name: '标记阻塞' }).click();
    await task.click({ button: 'right' }); await page.getByRole('button', { name: '录入进展', exact: true }).click();
    await page.getByLabel('进度百分比').fill('45'); await page.getByLabel('进展说明').fill('已完成第一阶段');
    await page.getByRole('button', { name: '保存进展' }).click();
    await expect(page.getByRole('form', { name: '录入进展' })).toHaveCount(0);
    const result = await handle.win.evaluate(() => window.todoList.todo.list({ status: ['blocked'] }));
    expect(result.ok && result.data.some(todo => todo.title === '悬浮任务操作测试' && todo.progress === 45 && todo.priority === 'very-high')).toBe(true);
    await page.getByRole('button', { name: '关闭悬浮窗', exact: true }).click();
    expect((await handle.win.evaluate(() => window.todoList.app.compactConfigure({}))).ok).toBe(true);
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#/compact'))!.isVisible())).toBe(false);
    await handle.win.evaluate(() => window.todoList.app.compactConfigure({ enabled: true }));
    await expect(task).toBeVisible();
  } finally { await handle.app.close(); }
});

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
    await expect(handle.win.getByRole('button', { name: '精简悬浮模式' })).toHaveCount(0);
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const created = handle.app.waitForEvent('window');
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#/compact'))!.minimize());
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
    expect(state.onTop).toBe(true); expect(state.resizable).toBe(true);
    // Native restore keeps the compact surface visible; minimizing reuses it.
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#/compact'))!.restore());
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#/compact'))!.isVisible())).toBe(true);
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#/compact'))!.minimize());
    await expect(compact.getByRole('main', { name: '精简待办' })).toBeVisible();
    expect(await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('#/compact')).length)).toBe(1);
    await expect(compact.locator('.compact-view__check')).toHaveCount(0);
    await compact.getByRole('button', { name: /^今日最先/ }).click({ button: 'right' });
    await compact.getByRole('button', { name: '标记完成', exact: true }).click();
    await expect(compact.locator('.compact-view__title')).not.toContainText(['今日最先']);
    await expect(compact.locator('.compact-view__row')).toHaveCount(5);
    const result = await handle.win.evaluate((id) => window.todoList.todo.get(id), ids[0]!);
    expect(result.ok && result.data?.status).toBe('done');
    await compact.getByRole('button', { name: /^今日稍后/ }).click();
    await expect.poll(() => handle.win.evaluate(() => location.hash)).toBe(`#/todo/${ids[1]}`);
    // Re-entry uses the same floating window and keeps its state.
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#/compact'))!.minimize());
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

test('compact preferences apply native opacity, preserve manual size and survive reopening', async () => {
  const handle = await launchApp();
  try {
    await handle.win.evaluate(() => window.todoList.app.compact(true));
    await expect.poll(() => handle.app.windows().find((page) => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const page = handle.app.windows().find((page) => page.url().endsWith('#/compact'))!;
    await expect(page.getByRole('button', { name: '悬浮设置', exact: true })).toBeVisible();
    // Select a native menu command without relying on OS-specific menu coordinates.
    await handle.app.evaluate(({ Menu }) => {
      const original = Menu.buildFromTemplate.bind(Menu);
      (globalThis as any).__compactMenuChoice = '40%';
      Menu.buildFromTemplate = (template) => {
        const menu = original(template);
        if (template.some((item) => item.label === '透明度')) menu.popup = () => {
          const entries = template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? item.submenu : [])]);
          const command = entries.find((item) => item.label === (globalThis as any).__compactMenuChoice);
          if (!command) throw new Error('Missing compact menu command');
          (command.click as () => void)();
        };
        return menu;
      };
    });
    await page.getByRole('button', { name: '悬浮设置', exact: true }).click();
    const configured = await page.evaluate(() => window.todoList.app.compactConfigure({}));
    expect(configured.ok && configured.data.alwaysOnTop).toBe(true);
    expect(await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getOpacity())).toBeCloseTo(.6, 2);
    // Exercise the native will-resize boundary; programmatic content fitting
    // must not overwrite the dimensions a user chose by dragging a border.
    await handle.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#/compact'))!;
      const bounds = { ...window.getBounds(), width: 310, height: 230 };
      window.emit('will-resize', { preventDefault() {} }, bounds, { edge: 'bottom-right' });
      window.setBounds(bounds);
    });
    await page.evaluate(() => window.todoList.app.compactSize(0));
    const resized = await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getBounds());
    expect(resized.height).toBeGreaterThan(200);
    await page.evaluate(() => window.todoList.app.compactConfigure({ alwaysOnTop: false }));
    const configPath = await handle.app.evaluate(({ app }) => app.getPath('userData'));
    await expect.poll(() => JSON.parse(readFileSync(join(configPath, 'config.json'), 'utf8')).compactWindow.manualSize).toBe(true);
    const saved = JSON.parse(readFileSync(join(configPath, 'config.json'), 'utf8')).compactWindow;
    expect(saved.opacity).toBe(.6); expect(saved.alwaysOnTop).toBe(false);
    expect(saved.bounds.height).toBeGreaterThan(200);
    await page.evaluate(() => window.todoList.app.compact(false));
    await handle.win.evaluate(() => window.todoList.app.compact(true));
    const reopened = await handle.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#/compact'))!;
      return { height: window.getBounds().height, opacity: window.getOpacity(), floating: window.isAlwaysOnTop() };
    });
    expect(reopened.height).toBeGreaterThan(200); expect(reopened.opacity).toBeCloseTo(.6, 2); expect(reopened.floating).toBe(false);
    await handle.app.evaluate(() => { (globalThis as any).__compactMenuChoice = '恢复紧凑尺寸'; });
    await page.getByRole('button', { name: '悬浮设置', exact: true }).click();
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getBounds().height)).toBeLessThan(100);
  } finally { await handle.app.close(); }
});
