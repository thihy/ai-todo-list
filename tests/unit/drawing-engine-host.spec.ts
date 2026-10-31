import { expect, it, vi } from 'vitest';
import { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';
import type { DrawingEngineCommand, DrawingEngineResult } from '../../src/shared/drawing-engine';

const command: DrawingEngineCommand = { kind: 'apply', drawingId: 'drawing', opId: 'once', baseRevision: 'observed', operations: [{ kind: 'update', id: 'node', changes: { text: 'new' } }] };
const result: DrawingEngineResult = { drawingId: 'drawing', opId: 'once', ok: true, state: 'completed', durable: true, revision: 'after' };

it('routes one edit to the latest owner, verifies acknowledgement ownership, and deduplicates pending and completed operations', async () => {
  const sendEngine = vi.fn();
  const host = new DrawingCanvasHost({ send: () => {}, sendEngine, navigate: () => {} });
  host.canvasReady({ drawingId: 'drawing' }, 10); host.canvasReady({ drawingId: 'drawing' }, 20);
  const first = host.runEngineCommand('todo', command); const duplicate = host.runEngineCommand('todo', command);
  expect(sendEngine).toHaveBeenCalledTimes(1); expect(sendEngine).toHaveBeenCalledWith(command, 20);
  host.engineResult(result, 10);
  expect(await host.runEngineCommand('todo', { kind: 'outcome', drawingId: 'drawing', opId: 'query', targetOpId: 'once' })).toMatchObject({ state: 'pending' });
  host.engineResult({ ...result, drawingId: 'another' }, 20);
  host.engineResult(result, 20);
  expect(await first).toEqual(result); expect(await duplicate).toEqual(result);
  host.canvasGone('drawing', 20); host.canvasGone('drawing', 10);
  expect(await host.runEngineCommand('todo', command)).toEqual(result);
  expect(sendEngine.mock.calls.filter(([value]) => value.kind === 'apply')).toHaveLength(1);
  expect(await host.runEngineCommand('todo', { ...command, baseRevision: 'different' })).toMatchObject({ ok: false, code: 'invalid' });
});

it('reports unknown outcome on timeout, accepts a late acknowledgement and never resends the original mutation', async () => {
  const sendEngine = vi.fn();
  const host = new DrawingCanvasHost({ send: () => {}, sendEngine, navigate: () => {}, ackTimeoutMs: 5 });
  host.canvasReady({ drawingId: 'drawing' }, 10);
  expect(await host.runEngineCommand('todo', command)).toMatchObject({ ok: false, state: 'unknown', code: 'unknown_outcome' });
  expect(await host.runEngineCommand('todo', command)).toMatchObject({ state: 'unknown' });
  host.engineResult(result, 10);
  expect(await host.runEngineCommand('todo', { kind: 'outcome', drawingId: 'drawing', opId: 'query', targetOpId: 'once' })).toEqual(result);
  expect(await host.runEngineCommand('todo', command)).toEqual(result);
  expect(sendEngine).toHaveBeenCalledTimes(1);
});

it('reports an unknown operation and a missing canvas explicitly without sending a mutation', async () => {
  const host = new DrawingCanvasHost({ send: () => {}, sendEngine: () => { throw Error('unexpected dispatch'); }, navigate: () => {}, readyTimeoutMs: 5 });
  expect(await host.runEngineCommand('todo', { kind: 'outcome', drawingId: 'drawing', opId: 'query', targetOpId: 'missing' })).toMatchObject({ state: 'unknown', code: 'unknown_outcome' });
  expect(await host.runEngineCommand('todo', command)).toMatchObject({ ok: false, code: 'unavailable', error: '打开实时画布超时' });
});
