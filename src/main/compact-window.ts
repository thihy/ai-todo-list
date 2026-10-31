import { BrowserWindow, Menu, screen } from 'electron';
import { join } from 'node:path';
import type { SettingsStore } from './settings/store';
import type { Todo } from '../shared/todo-types';
import type { CompactTaskAction } from '../shared/compact-task-menu';
import { normaliseCompactPreferences, type CompactPreferences } from '../shared/compact-preferences';

/** Presentation-only controller; task actions use the existing IPC API. */
export class CompactWindowController {
  private window: BrowserWindow | null = null;
  private destroying = false;
  private preferences: CompactPreferences;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private requested = false;
  private interactive = false;
  private pointerTimer: ReturnType<typeof setInterval> | undefined;
  private ignoringMouse = false;
  private interactionKey = '';
  private updateInteraction = (): void => {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const point = screen.getCursorScreenPoint(); const bounds = window.getBounds();
    // Keep only the title strip reachable while inactive. Coordinates are
    // Electron DIP units, so this also works across display scaling levels.
    const overTitle = point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + 34;
    const state = { active: this.interactive, opacity: this.preferences.opacity, titleHovered: overTitle };
    const key = JSON.stringify(state);
    if (key !== this.interactionKey) { this.interactionKey = key; window.webContents.send('app:compact-interaction', state); }
    const ignore = !this.interactive && !overTitle;
    if (ignore !== this.ignoringMouse) { window.setIgnoreMouseEvents(ignore, { forward: true }); this.ignoringMouse = ignore; }
  };
  private visibilityChanged: () => void = () => {};
  setVisibilityHandler(handler: () => void): void { this.visibilityChanged = handler; }
  isEnabled(): boolean { return this.preferences.enabled; }
  toggle(): void { this.configure({ enabled: !this.preferences.enabled }); }
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
  configure(patch: { enabled?: boolean; opacity?: number; alwaysOnTop?: boolean }): CompactPreferences {
    this.preferences = normaliseCompactPreferences({ ...this.preferences, ...patch });
    this.interactionKey = '';
    this.updateInteraction();
    this.window?.setAlwaysOnTop(this.preferences.alwaysOnTop);
    this.persist();
    if (patch.enabled === true) this.show();
    if (patch.enabled === false) { this.requested = false; this.window?.hide(); }
    if (patch.enabled !== undefined) this.visibilityChanged();
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
        this.fit(0);
        this.persist();
      } },
      { label: '展开主窗口', click: () => this.restore() },
      { label: '关闭悬浮窗', click: () => this.configure({ enabled: false }) },
    ]).popup({ window: this.window });
  }
  popupTaskMenu(todo: Pick<Todo, 'title' | 'status' | 'priority'>): Promise<CompactTaskAction> {
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.resolve(null);
    return new Promise(resolve => {
      const select = (action: CompactTaskAction): void => {
        if (!window.isDestroyed()) window.focus();
        resolve(action);
      };
      const menu = Menu.buildFromTemplate([
        { label: todo.title.slice(0, 80), enabled: false },
        { type: 'separator' },
        ...([['done', '标记完成'], ['doing', '开始处理'], ['blocked', '标记阻塞'], ['next', '恢复待办'], ['cancelled', '取消任务']] as const).map(([status, label]) => ({
          label, type: 'checkbox' as const, checked: todo.status === status, click: () => select({ kind: 'status', value: status }),
        })),
        { type: 'separator' },
        { label: '修改优先级', submenu: (['very-high', 'high', 'medium', 'low', 'very-low'] as const).map((priority, index) => ({
          label: ['极高', '高', '中', '低', '极低'][index], type: 'radio' as const, checked: todo.priority === priority,
          click: () => select({ kind: 'priority', value: priority }),
        })) },
        { label: '录入进展', click: () => select({ kind: 'progress' }) },
      ]);
      menu.popup({ window, callback: () => resolve(null) });
    });
  }
  show(): void {
    if (this.destroying || this.main.isDestroyed()) return;
    this.preferences = normaliseCompactPreferences(this.settings.get().compactWindow);
    // The floating window remains independent of main-window visibility.
    if (!this.preferences.enabled) { this.preferences.enabled = true; this.persist(); }
    this.requested = true;
    this.visibilityChanged();
    if (!this.window || this.window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const window = new BrowserWindow({
        width: 240, height: 172, x: area.x + area.width - 260, y: area.y + 32,
        ...this.preferences.bounds,
        minWidth: 200, minHeight: 92,
        frame: false, resizable: true, maximizable: false, fullscreenable: false,
        alwaysOnTop: this.preferences.alwaysOnTop, opacity: 1, skipTaskbar: true, show: false, transparent: true,
        backgroundColor: '#00000000', title: 'AI待办 · 精简模式',
        webPreferences: { preload: join(__dirname, '../preload/index.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      this.window = window;
      this.interactive = false;
      window.on('focus', () => { this.interactive = true; this.updateInteraction(); });
      window.on('blur', () => { this.interactive = false; this.updateInteraction(); });
      this.pointerTimer = setInterval(() => { if (window.isVisible()) this.updateInteraction(); }, 80);
      this.updateInteraction();
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
        this.interactionKey = ''; this.updateInteraction();
        if (!this.destroying && this.requested && !window.isDestroyed() && this.window === window) window.showInactive();
      });
      window.on('close', (event) => {
        if (!this.destroying) { event.preventDefault(); this.configure({ enabled: false }); }
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
      if (!window.webContents.isLoading()) window.showInactive();
    }
  }
  restore(todoId?: string): void {
    if (this.main.isMinimized()) this.main.restore();
    this.main.show(); this.main.focus();
    if (todoId) this.main.webContents.send('app:navigate', { route: `todo/${todoId}` });
  }
  fit(_count: number): void {
    if (this.window && !this.window.isDestroyed() && !this.preferences.manualSize) {
      this.window.setContentSize(this.window.getContentSize()[0], 172);
    }
  }
  destroy(): void {
    this.destroying = true;
    this.requested = false;
    clearTimeout(this.saveTimer);
    clearInterval(this.pointerTimer);
    this.persist();
    this.window?.destroy();
    this.window = null;
  }
}
