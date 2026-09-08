// Global hotkey registration + capture window lifecycle.

import { BrowserWindow, globalShortcut, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import { DEFAULT_CAPTURE_HOTKEY } from '../../shared/constants';
import { logger } from '../logger';

const CAPTURE_PRELOAD = join(__dirname, '../preload/index.cjs');

export class CaptureController {
  private win: BrowserWindow | null = null;
  private hotkey = DEFAULT_CAPTURE_HOTKEY;

  constructor() {}

  setHotkey(hotkey: string): void {
    if (this.hotkey === hotkey) return;
    globalShortcut.unregister(this.hotkey);
    this.hotkey = hotkey;
    this.registerHotkey();
  }

  registerHotkey(): boolean {
    try {
      const ok = globalShortcut.register(this.hotkey, () => this.toggle());
      if (!ok) {
        logger.warn(`global hotkey already taken: ${this.hotkey}`);
      }
      return ok;
    } catch (err) {
      logger.error(`global hotkey failed: ${(err as Error).message}`);
      return false;
    }
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isVisible()) this.win.hide();
      else {
        this.win.show();
        this.win.focus();
      }
    } else {
      this.create();
    }
  }

  create(): BrowserWindow {
    const opts: BrowserWindowConstructorOptions = {
      width: 520,
      height: 220,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'Quick capture',
      webPreferences: {
        preload: CAPTURE_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
    const win = new BrowserWindow(opts);
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(`${devUrl}/capture.html`);
    else void win.loadURL('app://thihy-todolist/capture.html');
    win.on('blur', () => setTimeout(() => win.hide(), 5_000));
    win.on('ready-to-show', () => {
      win.show();
      win.focus();
    });
    this.win = win;
    return win;
  }

  destroy(): void {
    try {
      globalShortcut.unregister(this.hotkey);
    } catch {
      // ignore
    }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}