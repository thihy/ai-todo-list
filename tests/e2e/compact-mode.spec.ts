import { test, expect } from '@playwright/test';
import { launchApp, type AppHandle } from './helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function chooseTaskMenu(handle: AppHandle, label: string): Promise<void> {
  await handle.app.evaluate(({ Menu }, choice) => {
    (globalThis as any).__compactTaskChoice = choice;
    if ((globalThis as any).__compactTaskSpy) return;
    (globalThis as any).__compactTaskSpy = true;
    const original = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = template => {
      const menu = original(template);
      if (template.some(item => item.label === '录入进展')) menu.popup = (options: any) => {
        const items = template.flatMap(item => [item, ...(Array.isArray(item.submenu) ? item.submenu : [])]);
        (globalThis as any).__compactTaskLabels = items.map(item => item.label).filter(Boolean);
        if ((globalThis as any).__compactTaskChoice === '__dismiss') { options?.callback?.(); return; }
        const item = items.find(item => item.label === (globalThis as any).__compactTaskChoice);
        if (!item?.click) throw Error('Missing native task action');
        (item.click as () => void)(); options?.callback?.();
      };
      return menu;
    };
  }, label);
}

test('floating tasks include children and grandchildren even when their parent is completed', async () => {
  const handle = await launchApp({ compactWindow: { enabled: false } });
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible();
    await handle.win.evaluate(async () => {
      const parent = await window.todoList.todo.create({ title: '已完成父任务', status: 'done' }); if (!parent.ok) throw Error(parent.message);
      const child = await window.todoList.todo.create({ title: '仍需完成的子任务', parentId: parent.data.id }); if (!child.ok) throw Error(child.message);
      await window.todoList.todo.create({ title: '仍需完成的孙任务', parentId: child.data.id, status: 'doing' });
      await window.todoList.app.compactConfigure({ enabled: true });
    });
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const page = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
    await expect(page.locator('.compact-view__title')).toHaveCount(2);
    await expect(page.getByText('仍需完成的子任务', { exact: true })).toBeVisible();
    await expect(page.getByText('仍需完成的孙任务', { exact: true })).toBeVisible();
    await expect(page.getByText('已完成父任务', { exact: true })).toHaveCount(0);
    await expect(page.locator('.compact-view__subtask')).toHaveCount(2);
  } finally { await handle.app.close(); }
});

test('saved hidden floating state survives startup and minimization, then restores saved display preferences', async () => {
  const handle = await launchApp({ compactWindow: { enabled: false, opacity: .4, alwaysOnTop: false, manualSize: true, bounds: { x: 100, y: 100, width: 310, height: 280 } } });
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible();
    expect(handle.app.windows().filter(page => page.url().endsWith('#/compact'))).toHaveLength(0);
    await handle.app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]!; main.minimize(); main.restore(); });
    const saved = await handle.win.evaluate(() => window.todoList.app.compactConfigure({}));
    expect(saved.ok && saved.data).toMatchObject({ enabled: false, opacity: .4, alwaysOnTop: false, bounds: { width: 310, height: 280 } });
    expect(handle.app.windows().filter(page => page.url().endsWith('#/compact'))).toHaveLength(0);
    await handle.win.getByRole('button', { name: '用户菜单', exact: true }).click();
    await handle.win.getByRole('menuitem', { name: '显示悬浮窗', exact: true }).click();
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const state = await handle.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!;
      return { bounds: win.getBounds(), onTop: win.isAlwaysOnTop(), min: win.getMinimumSize() };
    });
    expect(state.onTop).toBe(false); expect(state.min[1]).toBeGreaterThanOrEqual(92);
    expect(state.bounds.width).toBeGreaterThanOrEqual(310); expect(state.bounds.height).toBeGreaterThanOrEqual(280);
    await handle.win.getByRole('button', { name: '用户菜单', exact: true }).click();
    await handle.win.getByRole('menuitem', { name: '设置', exact: true }).click();
    await expect(handle.win.getByRole('checkbox', { name: '启用桌面悬浮窗', exact: true })).toHaveCount(0);
  } finally { await handle.app.close(); }
});

test('avatar and taskbar toggle persistent floating visibility independently, with height-driven rows and aligned icons', async () => {
  const handle = await launchApp();
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible();
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const page = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
    await expect(page.getByRole('main', { name: '精简待办' })).toBeVisible();
    await handle.app.evaluate(({ app, Menu }) => {
      const originalTasks = app.setUserTasks.bind(app);
      app.setUserTasks = tasks => { (globalThis as any).__floatingTasks = tasks; return originalTasks(tasks); };
      const originalMenu = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = template => {
        if (template[0]?.label === 'AI待办') (globalThis as any).__floatingTray = template;
        return originalMenu(template);
      };
    });
    await handle.win.getByRole('button', { name: '用户菜单', exact: true }).click();
    await handle.win.getByRole('menuitem', { name: '隐藏悬浮窗', exact: true }).click();
    const visible = () => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.isVisible());
    await expect.poll(visible).toBe(false);
    expect(await handle.app.evaluate(() => (globalThis as any).__floatingTasks[0].title)).toBe('显示悬浮窗');
    expect(await handle.app.evaluate(() => (globalThis as any).__floatingTray.some((item: any) => item.label === '显示悬浮窗'))).toBe(true);
    await handle.app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#/compact'))!; main.minimize(); main.restore(); });
    expect(await visible()).toBe(false);
    await handle.win.getByRole('button', { name: '用户菜单', exact: true }).click();
    await handle.win.getByRole('menuitem', { name: '显示悬浮窗', exact: true }).click();
    await expect.poll(visible).toBe(true);
    await handle.app.evaluate(() => (globalThis as any).__floatingTray.find((item: any) => item.label === '隐藏悬浮窗').click());
    await expect.poll(visible).toBe(false);
    await handle.app.evaluate(() => (globalThis as any).__floatingTray.find((item: any) => item.label === '显示悬浮窗').click());
    await expect.poll(visible).toBe(true);
    await handle.app.evaluate(({ app }) => { app.emit('second-instance', {}, ['app.exe', '--toggle-floating'], '', {}); });
    await expect.poll(visible).toBe(false);
    await handle.app.evaluate(({ app }) => { app.emit('second-instance', {}, ['app.exe', '--toggle-floating'], '', {}); });
    await expect.poll(visible).toBe(true);
    await handle.win.evaluate(async () => { for (let i = 0; i < 18; i++) await window.todoList.todo.create({ title: `高度验证 ${i}` }); });
    const resize = (height: number) => handle.app.evaluate(({ BrowserWindow }, height) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!;
      win.emit('will-resize', { preventDefault() {} }, { ...win.getBounds(), height }, { edge: 'bottom' });
      win.setContentSize(300, height);
    }, height);
    await resize(360);
    await expect.poll(() => page.locator('.compact-view__row').count()).toBeGreaterThan(6);
    const largeCount = await page.locator('.compact-view__row').count();
    expect(await page.locator('.compact-view__task-dot').count()).toBe(largeCount);
    const overflow = await page.locator('.compact-view__list').evaluate(element => ({ overflow: getComputedStyle(element).overflowY, height: element.clientHeight, content: element.scrollHeight }));
    expect(overflow.overflow).toBe('hidden'); expect(overflow.content).toBeLessThanOrEqual(overflow.height);
    const centers = await page.locator('.compact-view__actions svg').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return rect.y + rect.height / 2; }));
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    await page.screenshot({ path: test.info().outputPath('floating-height-driven.png') });
    await resize(130);
    await expect.poll(() => page.locator('.compact-view__row').count()).toBeLessThan(largeCount);
    await page.evaluate(() => window.todoList.app.compactConfigure({ opacity: .4, enabled: false }));
    await handle.win.evaluate(() => window.todoList.app.compactConfigure({ enabled: true }));
    expect(await page.evaluate(async () => { const result = await window.todoList.app.compactConfigure({}); return result.ok && result.data.opacity; })).toBe(.4);
    const configPath = await handle.app.evaluate(({ app }) => app.getPath('userData'));
    await expect.poll(() => JSON.parse(readFileSync(join(configPath, 'config.json'), 'utf8')).compactWindow.enabled).toBe(true);
  } finally { await handle.app.close(); }
});

test('inactive floating content passes through while its title can activate the opaque window', async () => {
  const handle = await launchApp();
  try {
    await handle.win.evaluate(() => window.todoList.app.compactConfigure({ enabled: true, opacity: .4 }));
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    await handle.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!;
      const bounds = win.getBounds();
      const point = { x: bounds.x + 50, y: bounds.y + 60 };
      (globalThis as any).__idlePoint = point;
      screen.getCursorScreenPoint = () => (globalThis as any).__idlePoint;
      const original = win.setIgnoreMouseEvents.bind(win);
      win.setIgnoreMouseEvents = (ignore, options) => { (globalThis as any).__compactIgnoring = ignore; original(ignore, options); };
      win.emit('focus');
      win.emit('blur');
    });
    await expect.poll(() => handle.app.evaluate(() => (globalThis as any).__compactIgnoring)).toBe(true);
    const page = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
    await expect.poll(() => page.locator('.compact-view__content').evaluate(element => getComputedStyle(element).opacity)).toBe('0.4');
    await expect.poll(() => page.locator('.compact-view__header').evaluate(element => getComputedStyle(element).opacity)).toBe('0.7');
    await handle.app.evaluate(({ BrowserWindow }) => { const bounds = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.getBounds(); (globalThis as any).__idlePoint = { x: bounds.x + 40, y: bounds.y + 12 }; });
    await expect.poll(() => handle.app.evaluate(() => (globalThis as any).__compactIgnoring)).toBe(false);
    await expect.poll(() => page.locator('.compact-view__header').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await expect.poll(() => page.locator('.compact-view__content').evaluate(element => getComputedStyle(element).opacity)).toBe('0.4');
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.focus());
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.getOpacity())).toBeCloseTo(1, 2);
    await expect.poll(() => page.locator('.compact-view__content').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await handle.app.evaluate(({ BrowserWindow }) => { (globalThis as any).__idlePoint = { x: 0, y: 0 }; BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.emit('blur'); });
    await expect.poll(() => handle.app.evaluate(() => (globalThis as any).__compactIgnoring)).toBe(true);
  } finally { await handle.app.close(); }
});

test('floating task menu updates priority, status and progress, and can be disabled', async () => {
  const handle = await launchApp();
  try {
    await handle.win.evaluate(async () => { const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; await window.todoList.todo.create({ title: '悬浮任务操作测试', priority: 'high', plannedFor: today }); await window.todoList.app.compactConfigure({ enabled: true }); });
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const page = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
    const task = page.getByRole('button', { name: /^悬浮任务操作测试/ });
    await expect(task).toBeVisible();
    await page.bringToFront();
    await expect(page.locator('.priority-high .compact-view__title')).toHaveText('悬浮任务操作测试');
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#/compact'))!.setContentSize(240, 92));
    await chooseTaskMenu(handle, '__dismiss');
    await task.focus(); await task.press('Shift+F10');
    await expect(page.locator('.priority-high .compact-view__title')).toHaveText('悬浮任务操作测试');
    await chooseTaskMenu(handle, '极高');
    await task.click({ button: 'right' });
    expect(await handle.app.evaluate(() => (globalThis as any).__compactTaskLabels)).toEqual(expect.arrayContaining(['标记完成', '开始处理', '标记阻塞', '恢复待办', '取消任务', '修改优先级', '极高', '高', '中', '低', '极低', '录入进展']));
    await expect(page.locator('.priority-very-high .compact-view__title')).toHaveText('悬浮任务操作测试');
    await chooseTaskMenu(handle, '标记阻塞'); await task.click({ button: 'right' });
    await chooseTaskMenu(handle, '录入进展'); await task.click({ button: 'right' });
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
    await handle.win.evaluate(() => window.todoList.app.compactConfigure({ enabled: true }));
    await expect.poll(() => handle.app.windows().find(page => page.url().endsWith('#/compact'))?.url()).toContain('#/compact');
    const compact = handle.app.windows().find(page => page.url().endsWith('#/compact'))!;
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
    await compact.bringToFront();
    await chooseTaskMenu(handle, '标记完成');
    await compact.getByRole('button', { name: /^今日最先/ }).click({ button: 'right' });
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
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getBounds().height)).toBeGreaterThanOrEqual(172);
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
    await page.bringToFront();
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
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getOpacity())).toBeCloseTo(1, 2);
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
    expect(reopened.height).toBeGreaterThan(200); expect(reopened.opacity).toBeCloseTo(1, 2); expect(reopened.floating).toBe(false);
    await handle.app.evaluate(() => { (globalThis as any).__compactMenuChoice = '恢复紧凑尺寸'; });
    await page.getByRole('button', { name: '悬浮设置', exact: true }).click();
    await expect.poll(() => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#/compact'))!.getContentBounds().height)).toBe(172);
  } finally { await handle.app.close(); }
});
