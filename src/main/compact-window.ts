import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

/** Presentation-only controller; task actions use the existing IPC API. */
export class CompactWindowController {
  private window: BrowserWindow | null = null;
  private destroying = false;
  constructor(private main: BrowserWindow) {}
  show(): void {
    if (!this.window || this.window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const window = new BrowserWindow({
        width: 240, height: 172, x: area.x + area.width - 260, y: area.y + 32,
        frame: false, resizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: true, skipTaskbar: true, show: false,
        backgroundColor: '#F6F7F9', title: 'AI待办 · 精简模式',
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      this.window = window;
      window.setMenu(null);
      window.once('ready-to-show', () => {
        if (!window.isDestroyed() && this.window === window) { window.show(); this.main.hide(); }
      });
      window.on('close', (event) => {
        if (!this.destroying) { event.preventDefault(); this.restore(); }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const devUrl = process.env['ELECTRON_RENDERER_URL'];
      void window.loadURL(devUrl ? `${devUrl.replace(/\/$/, '')}/#/compact` : 'app://todo-list/index.html#/compact');
    } else {
      const window = this.window;
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      window.setPosition(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
        Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)));
      window.show(); window.focus(); this.main.hide();
    }
  }
  restore(todoId?: string): void {
    this.window?.hide();
    if (this.main.isMinimized()) this.main.restore();
    this.main.show(); this.main.focus();
    if (todoId) this.main.webContents.send('app:navigate', { route: `todo/${todoId}` });
  }
  fit(count: number): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.setContentSize(240, 36 + Math.max(1, Math.min(5, Math.floor(count))) * 26);
    }
  }
  destroy(): void {
    this.destroying = true;
    this.window?.destroy();
    this.window = null;
  }
}
