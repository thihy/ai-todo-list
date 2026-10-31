import { expect, it } from 'vitest';
import { readLiveDrawingContext } from '../../src/renderer/drawing/live-context';
import { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';
import type { DrawingContextRequest } from '../../src/shared/drawing-engine';

it('reads unsaved live elements and selection without modifying the engine or saving transient state', async () => {
  const elements = [{ id: 'live', text: '尚未落盘的文字', version: 2 }];
  let selected = { live: true, ghost: true };
  const api = { getSceneElements: () => elements, getAppState: () => ({ selectedElementIds: selected, scrollX: 12, scrollY: -30, zoom: { value: 1.5 }, width: 800, height: 600 }), updateScene: () => { throw Error('Read must not mutate'); } };
  const first = await readLiveDrawingContext(api, 'drawing');
  expect(first.elements).toEqual(elements);
  expect(first.selectedElementIds).toEqual(['live']);
  expect(first.viewport).toEqual({ scrollX: 12, scrollY: -30, zoom: 1.5, width: 800, height: 600 });
  selected = { live: false, ghost: false };
  const second = await readLiveDrawingContext(api, 'drawing');
  expect(second.revision).toBe(first.revision);
  elements[0]!.text = '用户继续修改';
  expect(first.elements).toEqual([{ id: 'live', text: '尚未落盘的文字', version: 2 }]);
  expect((await readLiveDrawingContext(api, 'drawing')).revision).not.toBe(first.revision);
});

it('refuses to read a loading engine', async () => {
  await expect(readLiveDrawingContext({ getSceneElements: () => [], getAppState: () => ({ isLoading: true }), updateScene: () => {} }, 'drawing')).rejects.toThrow('尚未就绪');
});

it('targets one mounted owner and ignores another renderer or another drawing acknowledgement', async () => {
  let request!: DrawingContextRequest; let target = -1;
  const host = new DrawingCanvasHost({ send: () => {}, navigate: () => {}, ackTimeoutMs: 100,
    sendContext: (payload, owner) => { request = payload; target = owner; },
  });
  host.canvasReady({ drawingId: 'drawing' }, 10);
  host.canvasReady({ drawingId: 'drawing' }, 20);
  const result = host.readContext('todo', 'drawing');
  expect(target).toBe(20);
  host.contextResult({ ...request, ok: false, error: 'foreign renderer' }, 10);
  host.contextResult({ ...request, drawingId: 'wrong', ok: false, error: 'wrong drawing' }, 20);
  host.contextResult({ ...request, ok: false, error: 'real owner outcome' }, 20);
  expect(await result).toMatchObject({ ok: false, error: 'real owner outcome' });
  host.canvasGone('drawing', 20);
  expect(host.isLive('drawing')).toBe(true);
  const fallback = host.readContext('todo', 'drawing');
  expect(target).toBe(10);
  host.contextResult({ ...request, ok: false, error: 'remaining owner outcome' }, 10);
  expect(await fallback).toMatchObject({ error: 'remaining owner outcome' });
});

it('reports a missing live renderer response instead of fabricating context', async () => {
  const host = new DrawingCanvasHost({ send: () => {}, navigate: () => {}, sendContext: () => {}, ackTimeoutMs: 5 });
  host.canvasReady({ drawingId: 'drawing' }, 1);
  expect(await host.readContext('todo', 'drawing')).toMatchObject({ ok: false, error: '实时画布查询超时' });
});

it('prefers the focused owner and refuses to guess the current drawing when several canvases are mounted', async () => {
  let active: number | undefined = 10;
  let target = -1;
  const host = new DrawingCanvasHost({ send: () => {}, navigate: () => {}, activeOwner: () => active,
    sendContext: (request, owner) => { target = owner; host.contextResult({ ...request, ok: false, error: 'probe' }, owner); },
  });
  host.canvasReady({ drawingId: 'a' }, 10); host.canvasReady({ drawingId: 'a' }, 20);
  await host.readContext('todo', 'a'); expect(target).toBe(10); expect(host.activeDrawingId()).toBe('a');
  host.canvasReady({ drawingId: 'b' }, 20); active = 20;
  expect(host.activeDrawingId()).toBeUndefined();
  active = 10; expect(host.activeDrawingId()).toBe('a');
  active = undefined; expect(host.activeDrawingId()).toBeUndefined();
});
