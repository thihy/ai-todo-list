// Desktop floating pet. A transparent always-on-top frameless window
// the user drags content onto; main routes the drop through the composer
// inbox and broadcasts `app:external-ai-submit` for the main window's
// AIPane to take over. Mirrors `src/main/shortcuts/capture.ts` in shape
// (small standalone BrowserWindow controller) but is driven by
// settings.pet.enabled + a tray toggle rather than a hotkey.
//
// Position persistence: x/y live in `settings.pet.{x,y}`. On boot we
// validate against the current display union — if the saved coords
// fall outside every display's workArea (e.g. the user unplugged a
// monitor), we fall back to the default placement so the pet never
// lands off-screen.
//
// The window is intentionally `focusable: false` so clicking the pet
// doesn't steal focus from whatever app the user is dragging from —
// drops and the context menu still work because they're DOM-level
// events on the pet's webContents, not window-level focus events.

import { BrowserWindow, Menu, screen, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { SettingsStore } from '../settings/store';
import type { PetDragArgs } from '../../shared/todo-list-api';
import { logger } from '../logger';

const PET_PRELOAD = join(__dirname, '../preload/index.cjs');
const PET_WIDTH = 132;
const PET_HEIGHT = 132;
const DEFAULT_RIGHT_OFFSET = 24;
const DEFAULT_VERTICAL_FRACTION = 0.35;

export interface PetControllerDeps {
  /** Settings store — reads `pet.enabled` to decide whether to show
   *  the window at boot, and persists x/y on drag. */
  settings: SettingsStore;
  /** Resolves the main BrowserWindow so the pet can focus it on
   *  double-click / context-menu "打开主窗口" / HITL clicks. */
  getMainWindow: () => BrowserWindow | null;
}

export class PetController {
  private win: BrowserWindow | null = null;
  /** Last save timer — debounce position persistence so a drag storm
   *  doesn't hammer config.json. */
  private positionSaveTimer: NodeJS.Timeout | null = null;
  /** Exact (unrounded) window position captured at drag start, so
   *  per-frame deltas don't accumulate setPosition() rounding error.
   *  Null when no drag is in progress. */
  private dragAnchor: { x: number; y: number } | null = null;

  constructor(private deps: PetControllerDeps) {}

  /** Sync window lifecycle with the persisted setting. Called on
   *  boot AND on every `app:settings-changed` push so the toggle in
   *  Settings / tray menu takes effect without a restart. */
  applyEnabled(): void {
    const enabled = this.deps.settings.get().pet.enabled;
    if (enabled && !this.win) {
      const win = this.create();
      win.show();
    } else if (!enabled && this.win && !this.win.isDestroyed()) {
      this.destroy();
    } else if (enabled && this.win && !this.win.isVisible()) {
      this.win.show();
    }
  }

  /** Show the pet window. No-op if disabled. */
  show(): void {
    if (!this.deps.settings.get().pet.enabled) return;
    if (!this.win || this.win.isDestroyed()) this.create();
    this.win?.show();
  }

  /** Hide without destroying (preserves position). */
  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Drive one step of the pet's manual drag.
   *
   *  The pet window deliberately avoids `-webkit-app-region: drag`:
   *  Chromium hands an app-region drag to the OS as a native window move
   *  and never delivers HTML5 drag events to the page, which would kill
   *  the drop target (and show the "forbidden" cursor). The renderer
   *  therefore sends pointer deltas over `pet.drag` and we move here.
   *
   *  Deltas are accumulated against the position captured at drag start
   *  rather than applied to win.getPosition() each time — setPosition
   *  rounds to whole pixels, so re-reading the rounded position every
   *  frame would compound the rounding and make the pet drift away from
   *  the cursor. */
  dragBy(step: PetDragArgs): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (step.phase === 'start') {
      const [x, y] = this.win.getPosition();
      this.dragAnchor = { x, y };
      return;
    }
    if (step.phase === 'end') {
      this.dragAnchor = null;
      return;
    }
    // Moves before a start (or after an end) are ignored rather than
    // applied to a stale anchor.
    if (!this.dragAnchor) return;
    const { dx, dy } = step;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const x = this.dragAnchor.x + dx;
    const y = this.dragAnchor.y + dy;
    this.dragAnchor = { x, y };
    this.win.setPosition(Math.round(x), Math.round(y));
  }

  /** Toggle the persisted setting + sync the window. */
  toggle(): void {
    const cur = this.deps.settings.get().pet.enabled;
    this.deps.settings.patch({ pet: { enabled: !cur } });
    this.applyEnabled();
  }

  /** Programmatically focus the main window. Used by the pet's
   *  double-click and HITL click. */
  focusMain(): void {
    const main = this.deps.getMainWindow();
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }

  destroy(): void {
    if (this.positionSaveTimer) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.dragAnchor = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** True if the pet window currently exists and isn't destroyed.
   *  Used by tray menu / IPC handlers to decide whether to no-op. */
  hasWindow(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  private create(): BrowserWindow {
    const opts: BrowserWindowConstructorOptions = {
      width: PET_WIDTH,
      height: PET_HEIGHT,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      title: 'AI 宠物',
      webPreferences: {
        preload: PET_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
    // setAlwaysOnTop with level='screen-saver' puts the pet over
    // most alwaysOnTop windows but still under modal OS dialogs.
    const win = new BrowserWindow(opts);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(`${devUrl}/pet.html`);
    else void win.loadURL('app://todo-list/pet.html');

    // Initial position: persisted x/y if still on a visible display,
    // otherwise the default (right edge, slightly above mid-screen).
    const target = this.resolveInitialBounds();
    win.setBounds(target);

    // Right-click the pet → context menu. We listen at the window
    // level because the pet is `focusable: false` so the renderer
    // contextmenu event may not fire reliably.
    win.webContents.on('context-menu', (_e, params) => {
      this.popupContextMenu(win);
      void params;
    });

    // Persist drag position. 'moved' fires after each frame the
    // window moves; we debounce 500ms to coalesce drags into a single
    // config.json write.
    win.on('moved', () => this.scheduleSavePosition(win));

    win.on('ready-to-show', () => {
      win.show();
    });

    this.win = win;
    return win;
  }

  /** Compute the initial window bounds. Persisted x/y take priority
   *  if they fall inside ANY current display's workArea — otherwise
   *  fall back to the default placement so the pet never lands
   *  off-screen after a monitor unplug. */
  private resolveInitialBounds(): { x: number; y: number; width: number; height: number } {
    const { x, y } = this.deps.settings.get().pet;
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const validX = x !== null && this.isInsideAnyDisplay(x, y ?? wa.y + wa.height / 2);
    const validY = y !== null && this.isInsideAnyDisplay(x ?? wa.x + wa.width - 100, y);
    if (validX && validY && x !== null && y !== null) {
      return { x, y, width: PET_WIDTH, height: PET_HEIGHT };
    }
    return {
      x: wa.x + wa.width - PET_WIDTH - DEFAULT_RIGHT_OFFSET,
      y: Math.round(wa.y + wa.height * DEFAULT_VERTICAL_FRACTION),
      width: PET_WIDTH,
      height: PET_HEIGHT,
    };
  }

  /** True when (x, y) falls inside the workArea of at least one
   *  connected display. Used to validate persisted coords before
   *  applying them so the pet doesn't land on a disconnected monitor. */
  private isInsideAnyDisplay(x: number, y: number): boolean {
    const displays = screen.getAllDisplays();
    return displays.some((d) => {
      const w = d.workArea;
      return x >= w.x - PET_WIDTH && x <= w.x + w.width && y >= w.y - PET_HEIGHT && y <= w.y + w.height;
    });
  }

  /** Debounced position save. Writes 500ms after the last 'moved' so
   *  dragging the pet across the screen produces a single config.json
   *  write. */
  private scheduleSavePosition(win: BrowserWindow): void {
    if (this.positionSaveTimer) clearTimeout(this.positionSaveTimer);
    this.positionSaveTimer = setTimeout(() => {
      this.positionSaveTimer = null;
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      this.deps.settings.patch({ pet: { x, y } });
    }, 500);
  }

  /** Build + pop the pet's right-click menu. Lives in main so the
   *  menu follows the system theme + OS conventions and so the user
   *  can still reach "打开主窗口" when the main window is hidden. */
  private popupContextMenu(win: BrowserWindow): void {
    const menu = Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: () => this.focusMain(),
      },
      { type: 'separator' },
      {
        label: '重置位置',
        click: () => {
          this.deps.settings.patch({ pet: { x: null, y: null } });
          if (win && !win.isDestroyed()) {
            const target = this.resolveInitialBounds();
            win.setBounds(target);
          }
        },
      },
      {
        label: '隐藏悬浮宠物',
        click: () => this.hide(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          // app.quit triggers before-quit → destroy().
          // Lazy-import to avoid pulling the Electron app module in
          // unit tests that import this file in isolation.
          void import('electron').then(({ app }) => app.quit());
        },
      },
    ]);
    menu.popup({ window: win });
    void logger; // keep the import — used by tray on future error paths
  }
}