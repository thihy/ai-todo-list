import { expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';
import { drawingContextData, installDrawingAgentContext } from '../../src/main/drawing/agent-context';
import type { LiveDrawingContext } from '../../src/shared/drawing-engine';

const scene = (revision: string, text: string): LiveDrawingContext => ({ drawingId: 'drawing', revision,
  elements: [{ id: 'a', type: 'text', text, strokeColor: '#ff0000' }], selectedElementIds: ['a'],
  viewport: { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 } });

it('refreshes actual engine state on each scoped assembly, preserves literal templates and respects suppression and disposal', async () => {
  const ctx = new Context(); await ctx.plugin(SystemPrompt, {});
  const first = createScope(ctx, {}), other = createScope(ctx, {});
  let live = scene('one', 'before'); let requests = 0;
  const host = new DrawingCanvasHost({ send: () => {}, navigate: () => {},
    sendContext: (request, ownerId) => { requests++; host.contextResult({ ...request, ok: true, context: structuredClone(live) }, ownerId); } });
  host.canvasReady({ drawingId: 'drawing' }, 10);
  const sync = installDrawingAgentContext(first.ctx, host, () => 'todo');
  sync.bind(host.activeTarget());
  const prompt = ctx.get('systemPrompt') as SystemPrompt;
  try {
    const read = () => prompt.assemble({ scope: scopeOf(first.ctx) });
    expect(renderContextSnapshot(await read())).toContain('before');
    live = scene('two', '{{unknown_variable}}'); live.elements[0] = { ...(live.elements[0] as object), strokeColor: '#00ff00' };
    const updated = renderContextSnapshot(await read());
    expect(updated).toContain('{{unknown_variable}}'); expect(updated).toContain('#00ff00');
    expect(updated).toContain('"changed":["a"]'); expect(updated).toContain('"sinceRevision":"one"');
    expect(renderContextSnapshot(await prompt.assemble({ scope: scopeOf(other.ctx) }))).toBe('');
    const before = requests; const off = (first.ctx.get('systemPrompt') as SystemPrompt).suppressRuntimeContext();
    expect(renderContextSnapshot(await read())).toBe(''); expect(requests).toBe(before); off();
    host.canvasGone('drawing', 10); host.canvasReady({ drawingId: 'drawing' }, 10);
    expect(renderContextSnapshot(await read())).toContain('"available":false'); expect(requests).toBe(before);
    sync.bind(undefined); expect(renderContextSnapshot(await read())).toBe('');
    sync.dispose(); expect(renderContextSnapshot(await read())).toBe('');
  } finally { await first.dispose(); await other.dispose(); await ctx.fiber.dispose(); }
});

it('reports text/style/deletion/selection changes and bounds large scene summaries', () => {
  const before = scene('one', 'old'); before.elements.push({ id: 'removed' });
  const after = scene('two', 'new'); after.selectedElementIds = [];
  after.elements.push(...Array.from({ length: 300 }, (_, i) => ({ id: `added-${i}`, type: 'text', text: 'x'.repeat(5000) })));
  const data = drawingContextData(after, before), parsed = JSON.parse(data);
  expect(data.length).toBeLessThan(33000); expect(parsed.truncated).toBe(true);
  expect(parsed.elements[0].text).toBe('new'); expect(parsed.changes.changed).toEqual(['a']);
  expect(parsed.changes.removed).toEqual(['removed']); expect(parsed.changes.selectionChanged).toBe(true);
});
