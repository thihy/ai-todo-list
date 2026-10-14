import type { CaptureRect } from '../../shared/screenshot';
import koffi from 'koffi';

let native: ReturnType<typeof loadNative> | undefined;
function loadNative() {
  const user = koffi.load('user32.dll');
  const dwm = koffi.load('dwmapi.dll');
  const callback = koffi.proto('int __stdcall TodoScreenshotEnum(void *hwnd, intptr_t data)');
  return {
    enumerate: user.func('EnumWindows', 'int', [koffi.pointer(callback), 'intptr_t']),
    visible: user.func('int __stdcall IsWindowVisible(void *hwnd)'),
    minimized: user.func('int __stdcall IsIconic(void *hwnd)'),
    rect: user.func('int __stdcall GetWindowRect(void *hwnd, void *rect)'),
    title: user.func('int __stdcall GetWindowTextW(void *hwnd, void *text, int count)'),
    attribute: dwm.func('int __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, void *value, uint32_t size)'),
  };
}

/** Visible top-level windows in native stacking order. Physical screen coordinates. */
export function captureWindows(): Array<CaptureRect & { title: string }> {
  if (process.platform !== 'win32') return [];
  native ??= loadNative();
  const api = native;
  const windows: Array<CaptureRect & { title: string }> = [];
  api.enumerate((hwnd: unknown) => {
    if (!api.visible(hwnd) || api.minimized(hwnd)) return 1;
    const cloaked = Buffer.alloc(4);
    if (api.attribute(hwnd, 14, cloaked, 4) === 0 && cloaked.readUInt32LE() !== 0) return 1;
    const rect = Buffer.alloc(16);
    if (api.attribute(hwnd, 9, rect, 16) !== 0 && !api.rect(hwnd, rect)) return 1;
    const text = Buffer.alloc(1024);
    const count = api.title(hwnd, text, 512);
    const title = text.subarray(0, count * 2).toString('utf16le');
    const x = rect.readInt32LE(0), y = rect.readInt32LE(4);
    const width = rect.readInt32LE(8) - x, height = rect.readInt32LE(12) - y;
    if (width > 8 && height > 8 && title) windows.push({ x, y, width, height, title });
    return 1;
  }, 0);
  return windows;
}
