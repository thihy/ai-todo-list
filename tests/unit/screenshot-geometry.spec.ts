import { describe, it, expect } from 'vitest';
import { capturePixelRect, clampCaptureRect } from '../../src/shared/screenshot';

describe('screenshot selection geometry', () => {
  it('clips selections at display boundaries including negative origins', () => {
    expect(clampCaptureRect({ x: -20, y: 10, width: 70, height: 100 }, 100, 80)).toEqual({ x: 0, y: 10, width: 50, height: 70 });
  });
  it('rejects malformed or empty selections', () => {
    expect(clampCaptureRect({ x: NaN, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
    expect(clampCaptureRect({ x: 0, y: 0, width: -10, height: 10 }, 100, 100)).toBeNull();
    expect(clampCaptureRect({ x: 99, y: 99, width: 10, height: 10 }, 100, 100)).toBeNull();
  });
  it('converts DIP edges to captured pixels at fractional DPI without truncating the selection', () => {
    expect(capturePixelRect({ x: 1, y: 3, width: 11, height: 13 }, { width: 100, height: 80 }, { width: 150, height: 120 }))
      .toEqual({ x: 1, y: 4, width: 17, height: 20 });
  });
  it('uses the actual thumbnail dimensions, rather than assuming the display scale', () => {
    expect(capturePixelRect({ x: 80, y: 60, width: 50, height: 50 }, { width: 100, height: 80 }, { width: 200, height: 160 }))
      .toEqual({ x: 160, y: 120, width: 40, height: 40 });
  });
});
