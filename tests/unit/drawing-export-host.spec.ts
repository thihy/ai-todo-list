import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';
import type { DrawingExportPayload } from '../../src/shared/drawing-spec';

afterEach(() => vi.useRealTimers());
describe('drawing export handshake', () => {
  it('冷画布先打开再等待就绪，按绘图和 opId 匹配结果', async () => {
    const requests: DrawingExportPayload[] = [];
    const host = new DrawingCanvasHost({ send: vi.fn(), sendExport: (p) => requests.push(p),
      navigate: (_todoId, drawingId) => host.canvasReady({ drawingId }) });
    const pending = host.exportDrawing('t', 'd');
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    host.exported({ ...requests[0]!, drawingId: 'other', ok: true });
    host.exported({ ...requests[0]!, ok: true, dataUrl: 'png', width: 100, height: 50 });
    await expect(pending).resolves.toMatchObject({ ok: true, dataUrl: 'png', width: 100 });
  });
  it('并发导出彼此独立，超时后迟到结果不复活请求', async () => {
    vi.useFakeTimers();
    const requests: DrawingExportPayload[] = [];
    const host = new DrawingCanvasHost({ send: vi.fn(), sendExport: (p) => requests.push(p), navigate: vi.fn(), ackTimeoutMs: 20 });
    host.canvasReady({ drawingId: 'd' });
    const first = host.exportDrawing('t', 'd');
    const second = host.exportDrawing('t', 'd');
    host.exported({ ...requests[1]!, ok: true, dataUrl: 'second' });
    await expect(second).resolves.toMatchObject({ dataUrl: 'second' });
    await vi.advanceTimersByTimeAsync(21);
    await expect(first).resolves.toMatchObject({ ok: false, error: expect.stringContaining('超时') });
    host.exported({ ...requests[0]!, ok: true });
  });
  it('画布加载失败有界返回，不派发导出', async () => {
    vi.useFakeTimers();
    const sendExport = vi.fn();
    const host = new DrawingCanvasHost({ send: vi.fn(), sendExport, navigate: vi.fn(), readyTimeoutMs: 20 });
    const pending = host.exportDrawing('t', 'bad');
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(sendExport).not.toHaveBeenCalled();
  });
  it('发送和渲染失败返回明确错误', async () => {
    const host = new DrawingCanvasHost({ send: vi.fn(), sendExport: () => { throw new Error('closed'); }, navigate: vi.fn() });
    host.canvasReady({ drawingId: 'd' });
    await expect(host.exportDrawing('t', 'd')).resolves.toMatchObject({ ok: false, error: 'closed' });
  });
});
