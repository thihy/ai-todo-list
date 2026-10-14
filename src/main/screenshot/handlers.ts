import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron';
import { join } from 'node:path';
import { register, okResult, failResult } from '../ipc/router';
import { writeBlobToInbox } from '../ai/composer-inbox';
import { captureWindows } from './windows';
import { capturePixelRect, clampCaptureRect, type ScreenshotState } from '../../shared/screenshot';
import type { IpcResponse } from '../../shared/ipc-schema';
import { logger } from '../logger';

export function registerScreenshotHandlers(rootDir: string, getMain: () => BrowserWindow | null): void {
  type Overlay = { window: BrowserWindow; state: ScreenshotState; image: NativeImage };
  type CaptureSession = { overlays: Map<number, Overlay>; resolve: (value: IpcResponse<'app.screenshot'>) => void; conversationId: string | null; main: BrowserWindow | null; finishing: boolean };
  let active: CaptureSession | null = null;
  const finish = (result: IpcResponse<'app.screenshot'>): void => {
    const capture = active;
    active = null;
    if (!capture) return;
    for (const overlay of capture.overlays.values()) if (!overlay.window.isDestroyed()) overlay.window.destroy();
    if (capture.main && !capture.main.isDestroyed()) { capture.main.show(); capture.main.focus(); }
    capture.resolve(result);
  };
  register('app.screenshot', async (_event, req) => {
    if (active) return failResult('screenshot_busy', '截图已在进行中');
    const main = getMain();
    let resolveCapture!: CaptureSession['resolve'];
    const result = new Promise<IpcResponse<'app.screenshot'>>(resolve => { resolveCapture = resolve; });
    const capture: CaptureSession = { overlays: new Map(), resolve: resolveCapture, conversationId: req.conversationId ?? null, main, finishing: false };
    active = capture;
    try {
      main?.hide();
      await new Promise(resolve => setTimeout(resolve, 150));
      const displays = screen.getAllDisplays();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.max(...displays.map(d => Math.ceil(d.size.width * d.scaleFactor))),
        height: Math.max(...displays.map(d => Math.ceil(d.size.height * d.scaleFactor))),
      } });
      let windows: ReturnType<typeof captureWindows> = [];
      try { windows = captureWindows(); } catch (err) { logger.warn(`screenshot window detection: ${(err as Error).message}`); }
      for (const display of displays) {
        if (active !== capture || capture.finishing) break;
        const source = sources.find(s => s.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取显示器画面');
        const bounds = display.bounds;
        const physicalBounds = process.platform === 'win32' ? screen.dipToScreenRect(null, bounds) : bounds;
        const candidates = windows.map(w => {
          // Convert against THIS monitor, including windows spanning different DPI scales.
          const local = clampCaptureRect({ x: (w.x - physicalBounds.x) / display.scaleFactor,
            y: (w.y - physicalBounds.y) / display.scaleFactor,
            width: w.width / display.scaleFactor, height: w.height / display.scaleFactor }, bounds.width, bounds.height);
          return local ? { ...local, title: w.title } : null;
        }).filter((w): w is NonNullable<typeof w> => w !== null);
        const overlay = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: false,
          skipTaskbar: true, alwaysOnTop: true, title: '截图选区', backgroundColor: '#111111',
          webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        capture.overlays.set(overlay.webContents.id, { window: overlay, image: source.thumbnail,
          state: { image: source.thumbnail.toDataURL(), width: bounds.width, height: bounds.height, windows: candidates } });
        overlay.setAlwaysOnTop(true, 'screen-saver');
        overlay.on('closed', () => { if (active === capture && !capture.finishing) finish(okResult({ canceled: true })); });
        overlay.webContents.on('render-process-gone', () => { if (active === capture) finish(failResult('screenshot_failed', '截图窗口意外关闭')); });
        const dev = process.env['ELECTRON_RENDERER_URL'];
        await overlay.loadURL(dev ? `${dev}/screenshot.html` : 'app://todo-list/screenshot.html');
        if (active === capture && !capture.finishing) overlay.show();
        else if (!overlay.isDestroyed()) overlay.destroy();
      }
      const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (active === capture) {
        const selected = [...capture.overlays.values()].find(o => o.window.getBounds().x === cursorDisplay.bounds.x && o.window.getBounds().y === cursorDisplay.bounds.y);
        selected?.window.focus();
      }
    } catch (err) { if (active === capture) finish(failResult('screenshot_failed', (err as Error).message)); }
    return result;
  });
  register('screenshot.state', async event => {
    const overlay = active?.overlays.get(event.sender.id);
    return overlay ? okResult(overlay.state) : failResult('invalid_capture_window', '截图窗口已关闭');
  });
  register('screenshot.finish', async (event, req) => {
    const capture = active;
    const overlay = capture?.overlays.get(event.sender.id);
    if (!capture || !overlay || capture.finishing) return failResult('invalid_capture_window', '截图窗口已关闭');
    if (!req.rect) { finish(okResult({ canceled: true })); return okResult(undefined); }
    const rect = capturePixelRect(req.rect, overlay.state, overlay.image.getSize());
    if (!rect) return failResult('invalid_capture_rect', '请选取至少 2 × 2 的区域');
    capture.finishing = true;
    try {
      const file = await writeBlobToInbox(rootDir, `截图-${Date.now()}.png`, 'image/png', overlay.image.crop(rect).toPNG(), capture.conversationId);
      finish(okResult({ canceled: false, ...file }));
      return okResult(undefined);
    } catch (err) { finish(failResult('screenshot_failed', (err as Error).message)); return failResult('screenshot_failed', (err as Error).message); }
  });
}
