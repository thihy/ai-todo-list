// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  // Vendor module probes Canvas.filter while loading UI components. No drawing is mocked.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ filter: 'none' }) });
  Object.defineProperty(globalThis, 'FontFace', { configurable: true, value: class { constructor(public family: string) {} } });
});
import { convertToExcalidrawElements, setCustomTextMetricsProvider } from '@excalidraw/excalidraw';
import { LiveDrawingEngine } from '../../src/renderer/drawing/live-engine';
import { readLiveDrawingContext } from '../../src/renderer/drawing/live-context';
import type { DrawingEngineCommand, DrawingOperation } from '../../src/shared/drawing-engine';

// Keep the official conversion/binding code, with its supported non-canvas text measurement seam.
setCustomTextMetricsProvider({ getLineWidth: text => text.length * 10 });
function harness() {
  let elements: unknown[] = convertToExcalidrawElements([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 80, label: { text: '原文', id: 'label-a' } },
    { id: 'b', type: 'ellipse', x: 400, y: 0, width: 160, height: 80 },
    { id: 'user', type: 'rectangle', x: 20, y: 300, width: 100, height: 100, locked: true },
  ], { regenerateIds: false });
  const state = { selectedElementIds: { a: true }, scrollX: 70, scrollY: -20, zoom: { value: 1.5 }, width: 900, height: 600 };
  const save = vi.fn().mockResolvedValue(undefined);
  const updateScene = vi.fn((data: { elements?: unknown[] }) => { if (data.elements) elements = data.elements; });
  const api = { getSceneElements: () => elements, getAppState: () => state, updateScene, getFiles: () => ({}) };
  const beforeMutation = vi.fn();
  const engine = new LiveDrawingEngine(api, 'd1', save, beforeMutation);
  const context = () => readLiveDrawingContext(api, 'd1');
  const command = async (operations: DrawingOperation[], opId = crypto.randomUUID()): Promise<DrawingEngineCommand> => ({ drawingId: 'd1', opId, kind: 'apply', baseRevision: (await context()).revision, operations });
  return { api, engine, save, updateScene, beforeMutation, state, context, command };
}

describe('live drawing engine with official Excalidraw conversion', () => {
  it('waits for a delayed native selection commit before invoking the action', async () => {
    const h = harness(); const originalUpdate = h.updateScene.getMockImplementation()!;
    h.updateScene.mockImplementation((data: any) => {
      if (data.appState) requestAnimationFrame(() => requestAnimationFrame(() => Object.assign(h.state, data.appState)));
      else originalUpdate(data);
    });
    const invoke = vi.fn(async () => {
      expect(h.state.selectedElementIds).toEqual({ b: true });
      return { result: 'native-result-applied', ui: {} };
    });
    Object.assign(h.api, { getNativeActions: () => [{ name: 'copy', enabled: true, available: true, viewMode: true, label: 'copy' }], executeNativeAction: invoke });
    const command = { drawingId: 'd1', opId: 'delayed', kind: 'native-action' as const, baseRevision: (await h.context()).revision, action: 'copy', elementIds: ['b'] };
    expect(await h.engine.execute(command)).toMatchObject({ ok: true, liveChanged: false });
    expect(await h.engine.execute(command)).toMatchObject({ ok: true }); expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('adds text to a real container with the reported alignment fields and rejects duplicate or invalid containers', async () => {
    const h = harness();
    const result = await h.engine.execute(await h.command([{ kind: 'add', element: { id: 'bound-b', type: 'text', containerId: 'b', x: 400, y: 0, text: '绑定文字', textAlign: 'right', verticalAlign: 'bottom' } }]));
    expect(result).toMatchObject({ ok: true, durable: true });
    const after = await h.context();
    expect(after.elements.find((element: any) => element.id === 'bound-b')).toMatchObject({ containerId: 'b', originalText: '绑定文字', textAlign: 'right', verticalAlign: 'bottom' });
    expect(after.elements.find((element: any) => element.id === 'b')).toMatchObject({ boundElements: expect.arrayContaining([{ id: 'bound-b', type: 'text' }]) });
    expect(await h.engine.execute(await h.command([{ kind: 'add', element: { id: 'duplicate', type: 'text', containerId: 'b', x: 0, y: 0, text: '重复' } }]))).toMatchObject({ ok: false, liveChanged: false });
    expect(await h.engine.execute(await h.command([{ kind: 'add', element: { id: 'missing', type: 'text', containerId: 'missing-id', x: 0, y: 0, text: '错误' } }]))).toMatchObject({ ok: false, liveChanged: false });
    expect(await h.context()).toEqual(after);
  });
  it('edits the bound label, connects existing nodes and preserves unrelated elements and viewport', async () => {
    const h = harness(); const before = await h.context();
    const result = await h.engine.execute(await h.command([
      { kind: 'update', id: 'a', changes: { text: '新的内容', x: 30, backgroundColor: '#a5d8ff' } },
      { kind: 'connect', id: 'edge', from: 'a', to: 'b', label: '下一步' },
    ]));
    expect(result).toMatchObject({ ok: true, durable: true, liveChanged: true, checkpointId: expect.any(String) });
    const after = await h.context();
    expect(after.elements.find((e: any) => e.id === 'user')).toEqual(before.elements.find((e: any) => e.id === 'user'));
    expect(after.elements.find((e: any) => e.id === 'label-a')).toMatchObject({ text: '新的内容', containerId: 'a' });
    expect(after.elements.find((e: any) => e.id === 'edge')).toMatchObject({ startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } });
    expect(after.selectedElementIds).toEqual(['a']); expect(after.viewport).toEqual(before.viewport);
    expect(h.save).toHaveBeenCalledWith('d1', expect.objectContaining({ elements: after.elements, appState: expect.not.objectContaining({ selectedElementIds: expect.anything(), width: expect.anything() }) }));
  });

  it('rejects a later invalid operation atomically and rejects unsafe internal fields', async () => {
    const h = harness(); const before = await h.context();
    expect(await h.engine.execute(await h.command([
      { kind: 'update', id: 'a', changes: { x: 50 } }, { kind: 'connect', id: 'edge', from: 'a', to: 'missing' },
    ]))).toMatchObject({ ok: false, liveChanged: false });
    const unsafe = await h.command([{ kind: 'update', id: 'a', changes: { version: 500 } as never }]);
    expect(await h.engine.execute(unsafe)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h.context()).toEqual(before); expect(h.updateScene).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
    expect(h.beforeMutation).not.toHaveBeenCalled();
  });

  it('rejects stale scene versions and locked requested elements', async () => {
    const h = harness(); const stale = await h.command([{ kind: 'update', id: 'b', changes: { x: 500 } }]);
    await h.engine.execute(await h.command([{ kind: 'update', id: 'a', changes: { x: 10 } }]));
    h.beforeMutation.mockClear();
    expect(await h.engine.execute(stale)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await h.engine.execute(await h.command([{ kind: 'delete', id: 'user' }]))).toMatchObject({ ok: false, liveChanged: false });
    expect(h.beforeMutation).not.toHaveBeenCalled();
  });

  it('waits for persistence, exposes a pending outcome and never repeats an opId', async () => {
    const h = harness(); let complete!: () => void;
    h.save.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const command = await h.command([{ kind: 'add', element: { id: 'new', type: 'rectangle', x: 800, y: 50 } }], 'same-operation');
    const first = h.engine.execute(command); const duplicate = h.engine.execute(command);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(await h.engine.execute({ kind: 'outcome', opId: 'query', targetOpId: command.opId, drawingId: 'd1' })).toMatchObject({ state: 'pending', ok: false });
    complete(); const result = await first;
    expect(await duplicate).toEqual(result); expect(await h.engine.execute(command)).toEqual(result);
    expect(h.api.getSceneElements().filter((e: any) => e.id === 'new')).toHaveLength(1);
    expect(await h.engine.execute({ ...command, baseRevision: 'different' } as DrawingEngineCommand)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reports live changes after a save failure and can restore the actual prior drawing', async () => {
    const h = harness(); const original = await h.context(); h.save.mockRejectedValueOnce(Error('disk unavailable'));
    const failed = await h.engine.execute(await h.command([{ kind: 'update', id: 'a', changes: { text: '未保存' } }]));
    expect(failed).toMatchObject({ ok: false, code: 'save_failed', liveChanged: true, durable: false, checkpointId: expect.any(String) });
    const restored = await h.engine.execute({ kind: 'restore', drawingId: 'd1', opId: 'restore', checkpointId: failed.checkpointId!, baseRevision: (await h.context()).revision });
    expect(restored).toMatchObject({ ok: true, durable: true });
    expect(h.api.getSceneElements().find((e: any) => e.id === 'label-a')).toMatchObject({ text: '原文' });
    expect((await h.context()).viewport).toEqual(original.viewport);
  });

  it('does not restore over a later edit and cleans deleted node bindings without deleting surviving arrows', async () => {
    const h = harness();
    const connected = await h.engine.execute(await h.command([{ kind: 'connect', id: 'edge', from: 'a', to: 'b' }]));
    await h.engine.execute(await h.command([{ kind: 'delete', id: 'a' }]));
    const current = await h.context();
    expect(current.elements.some((e: any) => e.id === 'a' || e.id === 'label-a')).toBe(false);
    expect(current.elements.find((e: any) => e.id === 'edge')).toMatchObject({ startBinding: null, endBinding: { elementId: 'b' } });
    expect(await h.engine.execute({ kind: 'restore', drawingId: 'd1', opId: 'restore-late', checkpointId: connected.checkpointId!, baseRevision: current.revision })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await h.context()).toEqual(current);
  });

  it('repositions existing arrow endpoints and their label when a bound node moves', async () => {
    const h = harness();
    await h.engine.execute(await h.command([{ kind: 'connect', id: 'edge', from: 'a', to: 'b', label: '连接' }]));
    const initial = (await h.context()).elements.find((e: any) => e.id === 'edge');
    expect(await h.engine.execute(await h.command([{ kind: 'update', id: 'b', changes: { x: 700, y: 100 } }]))).toMatchObject({ ok: true });
    const final = (await h.context()).elements.find((e: any) => e.id === 'edge');
    expect(final).not.toEqual(initial);
    expect(final).toMatchObject({ startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } });
  });

  it('rebinds connected arrows when editing bound text directly resizes its container', async () => {
    const h = harness();
    await h.engine.execute(await h.command([{ kind: 'connect', id: 'edge', from: 'a', to: 'b' }]));
    const initial = h.api.getSceneElements().find((e: any) => e.id === 'edge');
    expect(await h.engine.execute(await h.command([{ kind: 'update', id: 'label-a', changes: { text: '一'.repeat(100) } }]))).toMatchObject({ ok: true, durable: true });
    expect(h.api.getSceneElements().find((e: any) => e.id === 'edge')).not.toEqual(initial);
    expect(h.api.getSceneElements().find((e: any) => e.id === 'label-a')).toMatchObject({ originalText: '一'.repeat(100), containerId: 'a' });
  });
});
