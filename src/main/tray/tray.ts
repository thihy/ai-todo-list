// System tray with capture / inbox / pause watcher / quit.

import { Menu, Tray, app, BrowserWindow } from 'electron';
import { logger } from '../logger';

export class TrayController {
  private tray: Tray | null = null;
  private onCapture: () => void = () => {};
  private onPauseClipboard: () => void = () => {};
  private clipboardPaused = false;

  constructor(private iconPath: string) {}

  setHandlers(onCapture: () => void, onPauseClipboard: () => void): void {
    this.onCapture = onCapture;
    this.onPauseClipboard = onPauseClipboard;
    this.refreshMenu();
  }

  setClipboardPaused(paused: boolean): void {
    this.clipboardPaused = paused;
    this.refreshMenu();
  }

  refreshMenu(): boolean {
    if (!this.tray) return false;
    const menu = Menu.buildFromTemplate([
      { label: 'thihy-todolist', enabled: false },
      { type: 'separator' },
      { label: '快速捕获  Ctrl+Shift+T', click: () => this.onCapture() },
      { type: 'separator' },
      { label: '显示主窗口', click: () => this.focusInbox() },
      { type: 'separator' },
      {
        label: this.clipboardPaused ? '✓ 剪贴板监听已暂停' : '暂停剪贴板监听',
        click: () => this.onPauseClipboard(),
      },
      { type: 'separator' },
      { label: '设置', click: () => this.focusInbox('settings') },
      { label: '退出', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
    return true;
  }

  private focusInbox(route?: string): void {
    const all = BrowserWindow.getAllWindows();
    const main = all.find((w) => !w.isDestroyed() && w.getSize()[0] >= 800);
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      if (route) {
        main.webContents.send('app:navigate', { route });
      }
    } else {
      app.emit('activate');
    }
  }

  install(): void {
    try {
      this.tray = new Tray(this.iconPath);
      this.refreshMenu();
      this.tray.setToolTip('thihy-todolist');
      this.tray.on('click', () => this.onCapture());
      logger.info('tray installed');
    } catch (err) {
      logger.error(`tray install failed: ${(err as Error).message}`);
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}