// 画布握手 / apply 派发 —— 单元测试。
//
// 这层是 B 版「用户看着 AI 画」的骨架，难点全在时序：画布没挂载时要先导航、
// 导航后要等就绪、apply 要等回执、超时之后迟到的回执必须被丢弃。
//
// 所以这里用**假时钟**（vi.useFakeTimers）而不是 sleep：握手路径涉及两段
// 各自独立的等待（等就绪 + 等回执），真等一次就要十几秒，而且超时分支根本
// 没法在真实时间里稳定复现。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DrawingCanvasHost } from '../../src/main/drawing/canvas-host';
import type { DrawingApplyPayload } from '../../src/shared/drawing-spec';

const SKELETONS = [
  { type: 'rectangle' as const, id: 'n0', x: 0, y: 0, width: 180, height: 60 },
];

function makeHost(overrides: Partial<ConstructorParameters<typeof DrawingCanvasHost>[0]> = {}) {
  const sent: DrawingApplyPayload[] = [];
  const navigations: Array<{ todoId: string; drawingId: string }> = [];
  const host = new DrawingCanvasHost({
    send: (p) => sent.push(p),
    navigate: (todoId, drawingId) => navigations.push({ todoId, drawingId }),
    readyTimeoutMs: 1_000,
    ackTimeoutMs: 1_000,
    ...overrides,
  });
  return { host, sent, navigations };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DrawingCanvasHost 画布就绪登记', () => {
  it('canvasReady 登记画布，canvasGone 注销', () => {
    const { host } = makeHost();
    expect(host.liveCount).toBe(0);
    host.canvasReady({ drawingId: 'd1' });
    expect(host.isLive('d1')).toBe(true);
    expect(host.liveCount).toBe(1);
    host.canvasGone('d1');
    expect(host.isLive('d1')).toBe(false);
    expect(host.liveCount).toBe(0);
  });

  it('重复 ready 不会重复计数', () => {
    const { host } = makeHost();
    host.canvasReady({ drawingId: 'd1' });
    host.canvasReady({ drawingId: 'd1' });
    expect(host.liveCount).toBe(1);
  });

  it('从未挂载过的 canvasGone 是安全的 no-op', () => {
    const { host } = makeHost();
    expect(() => host.canvasGone('ghost')).not.toThrow();
    expect(host.liveCount).toBe(0);
  });
});

describe('applyToCanvas —— 画布已就绪', () => {
  it('不发导航，直接下发 apply 并等回执', async () => {
    const { host, sent, navigations } = makeHost();
    host.canvasReady({ drawingId: 'd1' });

    const p = host.applyToCanvas({
      todoId: 't1',
      drawingId: 'd1',
      skeletons: SKELETONS,
    });
    // 让 applyToCanvas 跑到 send 之后。
    await vi.advanceTimersByTimeAsync(0);
    expect(navigations).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.drawingId).toBe('d1');

    host.applied({ opId: sent[0]!.opId, drawingId: 'd1', ok: true });
    await expect(p).resolves.toEqual({ ok: true, applied: true, error: undefined });
  });

  it('渲染进程回报失败时，把原因原样带回', async () => {
    const { host, sent } = makeHost();
    host.canvasReady({ drawingId: 'd1' });
    const p = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);
    host.applied({ opId: sent[0]!.opId, drawingId: 'd1', ok: false, error: 'Excalidraw 转换失败' });
    await expect(p).resolves.toEqual({
      ok: false,
      applied: false,
      error: 'Excalidraw 转换失败',
    });
  });

  it('空骨架直接短路，不发任何东西', async () => {
    const { host, sent } = makeHost();
    host.canvasReady({ drawingId: 'd1' });
    const res = await host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: [] });
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('applyToCanvas —— 画布未就绪（B 版的导航路径）', () => {
  it('先导航到该绘图，等就绪后再下发 apply', async () => {
    const { host, sent, navigations } = makeHost();
    const p = host.applyToCanvas({
      todoId: 't1',
      drawingId: 'd9',
      skeletons: SKELETONS,
      scrollToContent: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    // 导航已经发生，但 apply 还没发 —— 在等画布挂载。
    expect(navigations).toEqual([{ todoId: 't1', drawingId: 'd9' }]);
    expect(sent).toHaveLength(0);

    host.canvasReady({ drawingId: 'd9' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.scrollToContent).toBe(true);

    host.applied({ opId: sent[0]!.opId, drawingId: 'd9', ok: true });
    await expect(p).resolves.toMatchObject({ ok: true, applied: true });
  });

  it('导航后画布一直没起来 → 就绪超时，错误里带超时时长', async () => {
    const { host, sent } = makeHost({ readyTimeoutMs: 1_000 });
    const p = host.applyToCanvas({ todoId: 't1', drawingId: 'd9', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(1_100);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.error).toContain('1000ms');
    expect(sent).toHaveLength(0);
  });
});

describe('applyToCanvas —— 回执超时与迟到回执', () => {
  it('apply 发出后收不到回执 → 超时失败', async () => {
    const { host } = makeHost({ ackTimeoutMs: 800 });
    host.canvasReady({ drawingId: 'd1' });
    const p = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(900);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('800ms');
  });

  it('超时之后迟到的回执被丢弃，不会污染下一次调用', async () => {
    const { host, sent } = makeHost({ ackTimeoutMs: 500 });
    host.canvasReady({ drawingId: 'd1' });

    const first = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);
    const staleOpId = sent[0]!.opId;
    await vi.advanceTimersByTimeAsync(600);
    expect((await first).ok).toBe(false);

    // 迟到的回执：不该让 host 状态错乱，更不该 resolve 一个已经不存在的请求。
    expect(() =>
      host.applied({ opId: staleOpId, drawingId: 'd1', ok: true }),
    ).not.toThrow();

    // 紧接着再来一次，正常工作。
    const second = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.opId).not.toBe(staleOpId);
    host.applied({ opId: sent[1]!.opId, drawingId: 'd1', ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('未知 opId 的回执被安全忽略', () => {
    const { host } = makeHost();
    expect(() =>
      host.applied({ opId: 'never-sent', drawingId: 'd1', ok: true }),
    ).not.toThrow();
  });
});

describe('并发 —— 多张画布互不干扰', () => {
  it('两张画布各自的就绪只唤醒各自的请求', async () => {
    const { host, sent } = makeHost();
    const pA = host.applyToCanvas({ todoId: 't1', drawingId: 'dA', skeletons: SKELETONS });
    const pB = host.applyToCanvas({ todoId: 't2', drawingId: 'dB', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);

    host.canvasReady({ drawingId: 'dA' });
    await vi.advanceTimersByTimeAsync(0);
    // 只有 A 收到 apply，B 还在等自己的画布。
    expect(sent.map((s) => s.drawingId)).toEqual(['dA']);

    host.canvasReady({ drawingId: 'dB' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.drawingId)).toEqual(['dA', 'dB']);

    host.applied({ opId: sent[0]!.opId, drawingId: 'dA', ok: true });
    host.applied({ opId: sent[1]!.opId, drawingId: 'dB', ok: true });
    await expect(pA).resolves.toMatchObject({ ok: true });
    await expect(pB).resolves.toMatchObject({ ok: true });
  });

  it('同一张画布上排队的多个请求都会被唤醒', async () => {
    const { host, sent } = makeHost();
    const p1 = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    const p2 = host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);
    host.canvasReady({ drawingId: 'd1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    host.applied({ opId: sent[0]!.opId, drawingId: 'd1', ok: true });
    host.applied({ opId: sent[1]!.opId, drawingId: 'd1', ok: true });
    await expect(p1).resolves.toMatchObject({ ok: true });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });
});

describe('画布中途被关闭', () => {
  it('挂载又卸载后，下一次调用会重新走导航', async () => {
    const { host, navigations } = makeHost();
    host.canvasReady({ drawingId: 'd1' });
    host.canvasGone('d1');
    void host.applyToCanvas({ todoId: 't1', drawingId: 'd1', skeletons: SKELETONS });
    await vi.advanceTimersByTimeAsync(0);
    expect(navigations).toHaveLength(1);
  });
});
