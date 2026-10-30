import { BrowserWindow, Menu, screen } from 'electron';
import { join } from 'node:path';
import type { SettingsStore } from './settings/store';
import { normaliseCompactPreferences, type CompactPreferences } from '../shared/compact-preferences';

/** Presentation-only controller; task actions use the existing IPC API. */
export class CompactWindowController {
  private window: BrowserWindow | null = null;
  private destroying = false;
  private preferences: CompactPreferences;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private count = 5;
  constructor(private main: BrowserWindow, private settings: SettingsStore) {
    this.preferences = normaliseCompactPreferences(settings.get().compactWindow);
  }
  private persist(): void {
    if (this.window && !this.window.isDestroyed()) this.preferences.bounds = this.window.getBounds();
    this.settings.patch({ compactWindow: this.preferences });
  }
  private scheduleSave = (): void => {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 180);
  };
  configure(patch: { opacity?: number; alwaysOnTop?: boolean }): CompactPreferences {
    this.preferences = normaliseCompactPreferences({ ...this.preferences, ...patch });
    this.window?.setOpacity(this.preferences.opacity);
    this.window?.setAlwaysOnTop(this.preferences.alwaysOnTop);
    this.persist();
    return this.preferences;
  }
  popupMenu(): void {
    if (!this.window || this.window.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: '悬浮置顶', type: 'checkbox', checked: this.preferences.alwaysOnTop,
        click: () => this.configure({ alwaysOnTop: !this.preferences.alwaysOnTop }) },
      { label: '透明度', submenu: [0, 10, 20, 30, 40, 50, 60].map((percent) => ({
        label: percent === 0 ? '0%（不透明）' : `${percent}%`, type: 'radio' as const,
        checked: Math.round((1 - this.preferences.opacity) * 100) === percent,
        click: () => this.configure({ opacity: 1 - percent / 100 }),
      })) },
      { type: 'separator' },
      { label: '恢复紧凑尺寸', click: () => {
        this.preferences.manualSize = false;
        this.fit(this.count);
        this.persist();
      } },
      { label: '展开主窗口', click: () => this.restore() },
    ]).popup({ window: this.window });
  }
  show(): void {
    if (!this.window || this.window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const window = new BrowserWindow({
        width: 240, height: 172, x: area.x + area.width - 260, y: area.y + 32,
        ...this.preferences.bounds,
        minWidth: 200, minHeight: 64,
        frame: false, resizable: true, maximizable: false, fullscreenable: false,
        alwaysOnTop: this.preferences.alwaysOnTop, opacity: this.preferences.opacity, skipTaskbar: true, show: false,
        backgroundColor: '#F6F7F9', title: 'AI待办 · 精简模式',
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      this.window = window;
      const savedArea = screen.getDisplayMatching(window.getBounds()).workArea;
      const saved = window.getBounds();
      window.setBounds({ width: Math.min(saved.width, savedArea.width), height: Math.min(saved.height, savedArea.height),
        x: Math.max(savedArea.x, Math.min(saved.x, savedArea.x + savedArea.width - saved.width)),
        y: Math.max(savedArea.y, Math.min(saved.y, savedArea.y + savedArea.height - saved.height)) });
      window.on('will-resize', () => { this.preferences.manualSize = true; });
      window.on('resize', this.scheduleSave);
      window.on('move', this.scheduleSave);
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
    this.count = count;
    if (this.window && !this.window.isDestroyed() && !this.preferences.manualSize) {
      this.window.setContentSize(this.window.getContentSize()[0], Math.max(64, 36 + Math.max(1, Math.min(5, Math.floor(count))) * 26));
    }
  }
  destroy(): void {
    clearTimeout(this.saveTimer);
    this.persist();
    this.destroying = true;
    this.window?.destroy();
    this.window = null;
  }
}
