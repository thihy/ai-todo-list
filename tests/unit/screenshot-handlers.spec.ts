import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { id: number } }, req?: unknown) => Promise<unknown>>(),
  overlays: [] as Array<{ webContents: { id: number }; destroyed: boolean }>,
  crop: vi.fn(), png: vi.fn(() => Buffer.from('png')), write: vi.fn(),
  sources: vi.fn(), main: { hide: vi.fn(), show: vi.fn(), focus: vi.fn(), isDestroyed: () => false },
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { id: 100 + h.overlays.length, on: vi.fn() };
    destroyed = false;
    constructor() { h.overlays.push(this); }
    setAlwaysOnTop() {} on() {} show() {} focus() {}
    loadURL() { return Promise.resolve(); }
    getBounds() { return { x: 0, y: 0 }; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  },
  desktopCapturer: { getSources: h.sources },
  screen: {
    getAllDisplays: () => [{ id: 1, scaleFactor: 1.5, size: { width: 100, height: 80 }, bounds: { x: 0, y: 0, width: 100, height: 80 } }],
    screenToDipRect: (_window: unknown, rect: unknown) => rect,
    dipToScreenRect: () => ({ x: 0, y: 0, width: 150, height: 120 }),
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0 } }),
  },
}));
vi.mock('../../src/main/ipc/router', () => ({
  register: (name: string, handler: never) => h.handlers.set(name, handler),
  okResult: (data: unknown) => ({ ok: true, data }),
  failResult: (code: string, message: string) => ({ ok: false, code, message }),
}));
vi.mock('../../src/main/ai/composer-inbox', () => ({ writeBlobToInbox: h.write }));
vi.mock('../../src/main/screenshot/windows', () => ({ captureWindows: () => [{ x: 5, y: 5, width: 40, height: 40, title: 'Test' }] }));
vi.mock('../../src/main/logger', () => ({ logger: { warn: vi.fn() } }));
import { registerScreenshotHandlers } from '../../src/main/screenshot/handlers';

beforeEach(() => {
  vi.clearAllMocks(); h.overlays.length = 0; h.handlers.clear();
  h.crop.mockReturnValue({ toPNG: h.png });
  h.sources.mockResolvedValue([{ display_id: '1', thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,eA==', getSize: () => ({ width: 150, height: 120 }), crop: h.crop } }]);
  h.write.mockResolvedValue({ path: '/inbox/shot.png', name: 'shot.png', mime: 'image/png', size: 3 });
  registerScreenshotHandlers('/data', () => h.main as never);
});
async function open() {
  const result = h.handlers.get('app.screenshot')!({ sender: { id: 1 } }, { conversationId: 'conv' });
  await vi.waitFor(() => expect(h.overlays).toHaveLength(1));
  return { result, sender: { sender: { id: h.overlays[0]!.webContents.id } } };
}
describe('screenshot lifecycle', () => {
  it('confirms a DPI-correct crop into the original conversation inbox and restores the app', async () => {
    const { result, sender } = await open();
    await h.handlers.get('screenshot.finish')!(sender, { rect: { x: 10, y: 10, width: 20, height: 20 } });
    expect(h.crop).toHaveBeenCalledWith({ x: 15, y: 15, width: 30, height: 30 });
    expect(h.write.mock.calls[0]![4]).toBe('conv');
    expect(await result).toMatchObject({ ok: true, data: { canceled: false, path: '/inbox/shot.png' } });
    expect(h.overlays[0]!.destroyed).toBe(true); expect(h.main.show).toHaveBeenCalled();
  });
  it('cancels without saving and refuses non-overlay senders or concurrent captures', async () => {
    const { result, sender } = await open();
    expect(await h.handlers.get('screenshot.state')!({ sender: { id: 1 } })).toMatchObject({ ok: false });
    expect(await h.handlers.get('app.screenshot')!({ sender: { id: 1 } }, {})).toMatchObject({ code: 'screenshot_busy' });
    await h.handlers.get('screenshot.finish')!(sender, {});
    expect(await result).toMatchObject({ ok: true, data: { canceled: true } });
    expect(h.write).not.toHaveBeenCalled(); expect(h.main.focus).toHaveBeenCalled();
  });
  it('rejects a bad region while allowing the user to cancel afterwards', async () => {
    const { result, sender } = await open();
    expect(await h.handlers.get('screenshot.finish')!(sender, { rect: { x: 0, y: 0, width: 0, height: 20 } })).toMatchObject({ code: 'invalid_capture_rect' });
    await h.handlers.get('screenshot.finish')!(sender, {}); await result;
    expect(h.write).not.toHaveBeenCalled();
  });
  it('restores the app if desktop capture fails', async () => {
    h.sources.mockRejectedValueOnce(new Error('capture unavailable'));
    expect(await h.handlers.get('app.screenshot')!({ sender: { id: 1 } }, {})).toMatchObject({ ok: false, message: 'capture unavailable' });
    expect(h.main.show).toHaveBeenCalled();
  });
});
