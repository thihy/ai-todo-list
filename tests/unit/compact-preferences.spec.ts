import { describe, expect, it } from 'vitest';
import { normaliseCompactPreferences } from '../../src/shared/compact-preferences';
describe('compact preferences', () => {
  it('defaults to floating, opaque, auto-size without stored bounds', () => {
    expect(normaliseCompactPreferences(null)).toEqual({ opacity: 1, alwaysOnTop: true, manualSize: false, bounds: null });
  });
  it('keeps enough opacity to recover the window and repairs invalid geometry', () => {
    expect(normaliseCompactPreferences({ opacity: 0 }).opacity).toBe(.4);
    expect(normaliseCompactPreferences({ opacity: 2 }).opacity).toBe(1);
    expect(normaliseCompactPreferences({ opacity: NaN }).opacity).toBe(1);
    expect(normaliseCompactPreferences({ bounds: { x: 1, y: Infinity, width: 250, height: 200 } }).bounds).toBeNull();
    expect(normaliseCompactPreferences({ bounds: { x: -100, y: 2, width: 10, height: 5 } }).bounds)
      .toEqual({ x: -100, y: 2, width: 200, height: 64 });
  });
});
