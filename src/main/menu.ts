// Native application menu — Chinese labels. The menu bar is auto-hidden
// (autoHideMenuBar on the main window) so it does not clash with the dark
// custom UI; press Alt to reveal it. All entries are Chinese per the app locale.

import { Menu, app, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { logger } from './logger';

export interface AppMenuHandlers {
  /** Quick-capture toggle (same as tray / global hotkey). */
  onCapture: () => void;
  /** Resolve the focused main window so menu actions can talk to the renderer. */
  getMainWindow: () => BrowserWindow | null;
}

export function installAppMenu(handlers: AppMenuHandlers): void {
  const send = (channel: string, payload: unknown): void => {
    const win = handlers.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const focusMain = (): void => {
    const win = handlers.getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '快速捕获…',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => handlers.onCapture(),
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
          label: '退出 thihy-todolist',
          accelerator: 'CommandOrControl+Q',
          role: 'quit',
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo', accelerator: 'CommandOrControl+Z' },
        { label: '重做', role: 'redo', accelerator: 'Shift+CommandOrControl+Z' },
        { type: 'separator' },
        { label: '剪切', role: 'cut', accelerator: 'CommandOrControl+X' },
        { label: '复制', role: 'copy', accelerator: 'CommandOrControl+C' },
        { label: '粘贴', role: 'paste', accelerator: 'CommandOrControl+V' },
        { label: '全选', role: 'selectAll', accelerator: 'CommandOrControl+A' },
      ],
    },
    {
      label: '视图',
      submenu: [
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
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize', accelerator: 'CommandOrControl+M' },
        { label: '缩放', role: 'zoom' },
        { type: 'separator' },
        { label: '前置所有窗口', role: 'front' },
        { type: 'separator' },
        { label: '关闭', role: 'close', accelerator: 'CommandOrControl+W' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 thihy-todolist',
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
    },
  ];

  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    logger.info('application menu installed (zh-CN)');
  } catch (err) {
    logger.error(`application menu failed: ${(err as Error).message}`);
  }
}

export async function showAbout(): Promise<void> {
  const { dialog } = await import('electron');
  void dialog.showMessageBox(BrowserWindow.getFocusedWindow() ?? undefined as never, {
    type: 'info',
    title: '关于 thihy-todolist',
    message: 'thihy-todolist',
    detail: `版本 ${app.getVersion()}\nAI 原生 TODO 清单 · Markdown 进展 · Excalidraw 绘图\nCopyright © 2026 thihy`,
    buttons: ['确定'],
  });
}
