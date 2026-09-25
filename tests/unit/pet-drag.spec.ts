// PetController.dragBy — the manual window drag that replaced
// `-webkit-app-region: drag`.
//
// 关键不变量：
//   1. `-webkit-app-region: drag` 会让 Chromium 把该区域交给 OS 当原生
//      窗口移动，HTML5 drop 事件根本收不到 —— 所以宠物改成自己实现拖动。
//   2. `start` 快照当前窗口位置；`move` 施加**增量** delta；`end` 收尾。
//   3. 增量必须累加在 main 侧的锚点上，不能每帧读 getPosition() 再加：
//      setPosition 只认整数像素，反复读回会让误差累积，宠物会越拖越偏。
//   4. 没有 start 就来的 move（陈旧锚点）必须被忽略，而不是乱移窗口。

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), setThreshold: vi.fn() },
}));

import { PetController } from '../../src/main/pet/pet';
import type { SettingsStore } from '../../src/main/settings/store';

/** Minimal window stand-in. setPosition rounds like Electron's does. */
function makeFakeWin(start: { x: number; y: number }) {
  const pos = { ...start };
  return {
    pos,
    setPosition: vi.fn((x: number, y: number) => {
      // Electron setPosition takes integers; a float is coerced.
      pos.x = Math.round(x);
      pos.y = Math.round(y);
    }),
    getPosition: () => [pos.x, pos.y] as [number, number],
    isDestroyed: () => false,
    isVisible: () => true,
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeController() {
  const settings = {
    get: () => ({ pet: { enabled: true, x: null, y: null } }),
    patch: vi.fn(),
  } as unknown as SettingsStore;
  const ctl = new PetController({ settings, getMainWindow: () => null });
  const win = makeFakeWin({ x: 100, y: 200 });
  // @ts-expect-error — inject the fake window the way create() would.
  ctl.win = win;
  return { ctl, win };
}

describe('PetController.dragBy', () => {
  let ctl: PetController;
  let win: ReturnType<typeof makeFakeWin>;

  beforeEach(() => {
    ({ ctl, win } = makeController());
  });

  it('a start followed by one move shifts the window by the delta', () => {
    ctl.dragBy({ phase: 'start' });
    ctl.dragBy({ phase: 'move', dx: 30, dy: 45 });
    expect(win.pos).toEqual({ x: 130, y: 245 });
  });

  it('accumulates moves onto the start anchor rather than re-reading the window', () => {
    ctl.dragBy({ phase: 'start' });
    // Ten 1.4px steps. Accumulating on the anchor gives exactly 100 + 14 =
    // 114. The wrong implementation — re-reading the rounded position each
    // frame — truncates the 0.4 remainder every time and stalls at 110, so
    // this expectation fails there and the 4px drag lag is caught.
    for (let i = 0; i < 10; i++) ctl.dragBy({ phase: 'move', dx: 1.4, dy: 0 });
    expect(win.pos.x).toBe(114);
  });

  it('ignores a move that arrives without a preceding start', () => {
    // Stale anchor: the controller was never told a drag began.
    ctl.dragBy({ phase: 'move', dx: 50, dy: 50 });
    expect(win.setPosition).not.toHaveBeenCalled();
    expect(win.pos).toEqual({ x: 100, y: 200 });
  });

  it('a move after end is ignored until the next start', () => {
    ctl.dragBy({ phase: 'start' });
    ctl.dragBy({ phase: 'move', dx: 10, dy: 10 });
    ctl.dragBy({ phase: 'end' });
    win.setPosition.mockClear();
    ctl.dragBy({ phase: 'move', dx: 999, dy: 999 });
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it('re-anchors on a second drag instead of continuing from the first', () => {
    ctl.dragBy({ phase: 'start' });
    ctl.dragBy({ phase: 'move', dx: 100, dy: 0 });
    expect(win.pos.x).toBe(200);

    ctl.dragBy({ phase: 'start' }); // re-snapshots at the current position
    ctl.dragBy({ phase: 'move', dx: 10, dy: 0 });
    expect(win.pos.x).toBe(210);
  });

  it('drops a non-finite delta instead of moving the window to NaN', () => {
    ctl.dragBy({ phase: 'start' });
    ctl.dragBy({ phase: 'move', dx: Number.NaN, dy: 5 });
    expect(win.pos).toEqual({ x: 100, y: 200 });
  });
});
