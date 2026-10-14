export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface ScreenshotState {
  image: string;
  width: number;
  height: number;
  windows: Array<CaptureRect & { title: string }>;
}

export function clampCaptureRect(rect: CaptureRect, width: number, height: number): CaptureRect | null {
  if (![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite)) return null;
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  const right = Math.max(x, Math.min(width, rect.x + rect.width));
  const bottom = Math.max(y, Math.min(height, rect.y + rect.height));
  return right - x >= 2 && bottom - y >= 2 ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Convert DIP selection edges to captured pixels, preserving mixed-DPI accuracy. */
export function capturePixelRect(rect: CaptureRect, view: { width: number; height: number }, pixels: { width: number; height: number }): CaptureRect | null {
  const clipped = clampCaptureRect(rect, view.width, view.height);
  if (!clipped) return null;
  const x = Math.floor(clipped.x * pixels.width / view.width);
  const y = Math.floor(clipped.y * pixels.height / view.height);
  const right = Math.min(pixels.width, Math.ceil((clipped.x + clipped.width) * pixels.width / view.width));
  const bottom = Math.min(pixels.height, Math.ceil((clipped.y + clipped.height) * pixels.height / view.height));
  return { x, y, width: right - x, height: bottom - y };
}
