// Native application menu — Chinese labels. The menu bar is auto-hidden
// (autoHideMenuBar on the main window) so it does not clash with the dark
// custom UI; press Alt to reveal it. All entries are Chinese per the app locale.
//
// The topbar exposes the five top-level categories as flat buttons (文件 / 编辑 /
// 视图 / 窗口 / 帮助); clicking one pops that category's submenu via
// popupCategory(). This keeps the native roles (undo/copy/reload/devtools…)
// working — they only execute in the main process — while laying the categories
// out directly in the title bar instead of hiding them behind a single "菜单".

import { Menu, app, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { logger } from './logger';

export interface AppMenuHandlers {
  /** Quick-capture toggle (same as tray / global hotkey). */
  onCapture: () => void;
  /** Resolve the focused main window so menu actions can talk to the renderer. */
  getMainWindow: () => BrowserWindow | null;
}

export type MenuCategory = '文件' | '编辑' | '视图' | '窗口' | '帮助';

// Stored so popupCategory (called from IPC, no handlers arg) can rebuild a
// category's submenu on demand.
let menuHandlers: AppMenuHandlers | null = null;

function buildSubmenus(h: AppMenuHandlers): Record<MenuCategory, MenuItemConstructorOptions[]> {
  const send = (channel: string, payload: unknown): void => {
    const win = h.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const focusMain = (): void => {
    const win = h.getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  };

  return {
    文件: [
      {
        label: '快速捕获…',
        accelerator: 'CommandOrControl+Shift+T',
        click: () => h.onCapture(),
      },
      {
        label: '设置…',
        accelerator: 'CommandOrControl+,',
        click: () => {
          focusMain();
          send('app:navigate', { route: 'settings' });
        },
      },
      {
        label: '统计…',
        click: () => {
          focusMain();
          send('app:navigate', { route: 'stats' });
        },
      },
      { type: 'separator' },
      {
        label: '退出 AI待办',
        accelerator: 'CommandOrControl+Q',
        role: 'quit',
      },
    ],
    编辑: [
      { label: '撤销', role: 'undo', accelerator: 'CommandOrControl+Z' },
      { label: '重做', role: 'redo', accelerator: 'Shift+CommandOrControl+Z' },
      { type: 'separator' },
      { label: '剪切', role: 'cut', accelerator: 'CommandOrControl+X' },
      { label: '复制', role: 'copy', accelerator: 'CommandOrControl+C' },
      { label: '粘贴', role: 'paste', accelerator: 'CommandOrControl+V' },
      { label: '全选', role: 'selectAll', accelerator: 'CommandOrControl+A' },
    ],
    视图: [
      { label: '重新加载', role: 'reload', accelerator: 'CommandOrControl+R' },
      { label: '强制重新加载', role: 'forceReload', accelerator: 'Shift+CommandOrControl+R' },
      { label: '开发者工具', role: 'toggleDevTools', accelerator: 'Alt+CommandOrControl+I' },
      { type: 'separator' },
      { label: '放大', role: 'zoomIn', accelerator: 'CommandOrControl+=' },
      { label: '缩小', role: 'zoomOut', accelerator: 'CommandOrControl+-' },
      { label: '重置缩放', role: 'resetZoom', accelerator: 'CommandOrControl+0' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' },
      { type: 'separator' },
      {
        label: '切换 AI 助手面板',
        accelerator: 'CommandOrControl+Shift+I',
        click: () => {
          focusMain();
          send('app:toggle-ai', {});
        },
      },
    ],
    窗口: [
      { label: '最小化', role: 'minimize', accelerator: 'CommandOrControl+M' },
      { label: '缩放', role: 'zoom' },
      { type: 'separator' },
      { label: '前置所有窗口', role: 'front' },
      { type: 'separator' },
      { label: '关闭', role: 'close', accelerator: 'CommandOrControl+W' },
    ],
    帮助: [
      {
        label: '关于 AI待办',
        click: () => {
          focusMain();
          void showAbout();
        },
      },
      {
        label: '检查更新',
        click: () => send('app:update-available', { version: '' }),
      },
    ],
  };
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  menuHandlers = handlers;
  const subs = buildSubmenus(handlers);
  const template: MenuItemConstructorOptions[] = (Object.keys(subs) as MenuCategory[]).map(
    (label) => ({ label, submenu: subs[label] }),
  );
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    logger.info('application menu installed (zh-CN)');
  } catch (err) {
    logger.error(`application menu failed: ${(err as Error).message}`);
  }
}

/** Pop a single category's submenu as a native context menu. Called from the
 *  topbar's flat category buttons via the app.popupMenuCategory IPC. */
export function popupCategory(category: MenuCategory, win?: BrowserWindow): void {
  if (!menuHandlers) return;
  const subs = buildSubmenus(menuHandlers);
  const options = subs[category];
  if (!options) return;
  const menu = Menu.buildFromTemplate(options);
  // No explicit x/y → pops at the current cursor position, which sits on the
  // topbar category button the user just clicked.
  menu.popup({ window: win });
}

export async function showAbout(): Promise<void> {
  const { dialog } = await import('electron');
  void dialog.showMessageBox(BrowserWindow.getFocusedWindow() ?? undefined as never, {
    type: 'info',
    title: '关于 AI待办',
    message: 'AI待办',
    detail: `版本 ${app.getVersion()}\nAI 原生 TODO 清单 · Markdown 进展 · Excalidraw 绘图\nCopyright © 2026 todo-list`,
    buttons: ['确定'],
  });
}
