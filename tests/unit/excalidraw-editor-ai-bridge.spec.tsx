// @vitest-environment happy-dom
//
// ExcalidrawEditor 的 AI 绘图接线 —— 回归测试。
//
// 这里锁的是两个「不接就静默失效」的点：
//
// 1. **canvasReady 必须真的发出去。** main 的 applyToCanvas 等的就是它。
//    没发 → 工具一路等到超时 → AI 说「画好了」但画布上什么都没有，而且
//    没有任何报错指向真正的原因（超时报的是 apply 的超时，不是握手失败）。
//
// 2. **canvasGone 必须在卸载时发出去。** 漏发的话 main 以为画布还活着，
//    把 apply 推给一个已经 unmount 的 API，元素静默丢失；反过来，用户手动
//    关掉再打开画布后，AI 会一直以为「已经开着」。
//
// 组件本身要动态 import @excalidraw/excalidraw（浏览器 bundle），这里把它
// mock 成一个可控的假组件：挂载时通过 excalidrawAPI 回调交出一个假 API，
// 渲染端的 apply 逻辑因此可以在 happy-dom 里跑完整条链路。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const excalMock = vi.hoisted(() => ({
  convertToExcalidrawElements: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
}));

vi.mock('@excalidraw/excalidraw', async () => {
  const react = await import('react');
  excalMock.convertToExcalidrawElements.mockImplementation((skeletons: Array<{ id: string }>) =>
    skeletons.map((s) => ({ ...s, version: 1, versionNonce: 3 })),
  );
  return {
    ...excalMock,
    // 假的 Excalidraw 组件：挂载时把假 API 交给 excalidrawAPI 回调。
    Excalidraw: (props: {
      excalidrawAPI?: (api: unknown) => void;
      initialData?: { elements?: unknown[] };
      onChange?: (els: unknown[], st: Record<string, unknown>) => void;
    }) => {
      react.useEffect(() => {
        props.excalidrawAPI?.({
          updateScene: () => undefined,
          getSceneElements: () => [],
          getAppState: () => ({}),
          scrollToContent: () => undefined,
        });
      }, []);
      void props.initialData;
      void props.onChange;
      return null;
    },
  };
});

vi.mock('../../src/renderer/components/Toast', () => ({
  useToastBus: () => ({ push: vi.fn() }),
}));

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  canvasReady: [] as string[],
  canvasGone: [] as string[],
  applied: [] as Array<{ opId: string; ok: boolean; error?: string }>,
  scene: { elements: [] as unknown[], appState: {} as Record<string, unknown> },
  saves: [] as Array<{ drawingId: string; count: number }>,
}));

import { ExcalidrawEditor } from '../../src/renderer/components/ExcalidrawEditor';

beforeEach(() => {
  harness.listeners.clear();
  harness.canvasReady = [];
  harness.canvasGone = [];
  harness.applied = [];
  harness.scene = { elements: [], appState: {} };
  harness.saves = [];
  (globalThis as unknown as { window: Record<string, unknown> }).window.todoList = {
    drawing: {
      read: vi.fn(() => Promise.resolve({ ok: true, data: harness.scene })),
      save: vi.fn((_id: string, _s: unknown, drawingId?: string) => {
        harness.saves.push({ drawingId: drawingId ?? '', count: harness.saves.length });
        return Promise.resolve({ ok: true, data: {} });
      }),
      canvasReady: vi.fn((p: { drawingId: string }) => {
        harness.canvasReady.push(p.drawingId);
        return Promise.resolve({ ok: true, data: undefined });
      }),
      canvasGone: vi.fn((id: string) => {
        harness.canvasGone.push(id);
        return Promise.resolve({ ok: true, data: undefined });
      }),
      applied: vi.fn((p: { opId: string; ok: boolean; error?: string }) => {
        harness.applied.push({ opId: p.opId, ok: p.ok, error: p.error });
        return Promise.resolve({ ok: true, data: undefined });
      }),
    },
  };
});

/** useAppEvent 走的桥：注册一个可手动触发的监听器。 */
function useAppEventBridge(): void {
  // 组件内部通过 ../hooks/useTodoListApi 的 useAppEvent 订阅，
  // 它的实现基于 window.todoList.on。这里替换 on 为直接登记。
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.todoList = {
    ...(w.todoList as Record<string, unknown>),
    on: (event: string, cb: (payload: unknown) => void) => {
      harness.listeners.set(event, cb);
      return () => harness.listeners.delete(event);
    },
  };
}

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mountEditor(drawingId = 'd1'): Promise<void> {
  useAppEventBridge();
  await act(async () => {
    root.render(<ExcalidrawEditor todoId="t1" drawingId={drawingId} />);
    await Promise.resolve();
  });
}

describe('ExcalidrawEditor —— 画布握手', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('挂载后上报 canvasReady', async () => {
    await mountEditor('d1');
    expect(harness.canvasReady).toContain('d1');
  });

  it('drawingId 为空时不上报', async () => {
    await mountEditor('');
    expect(harness.canvasReady).not.toContain('');
  });

  it('卸载时上报 canvasGone', async () => {
    await mountEditor('d1');
    act(() => root.unmount());
    expect(harness.canvasGone).toContain('d1');
  });

  it('订阅了 app:drawing-apply', async () => {
    await mountEditor('d1');
    expect(harness.listeners.has('app:drawing-apply')).toBe(true);
  });
});

describe('ExcalidrawEditor —— 接收 apply 并回执', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('收到本画布的 apply 后回执 ok，并落盘一次', async () => {
    await mountEditor('d1');
    const cb = harness.listeners.get('app:drawing-apply')!;
    await act(async () => {
      cb({
        drawingId: 'd1',
        opId: 'op-1',
        skeletons: [{ type: 'rectangle', id: 'ai-node-0', x: 0, y: 0, width: 180, height: 60 }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.applied).toEqual([{ opId: 'op-1', ok: true, error: undefined }]);
    expect(harness.saves.length).toBe(1);
  });

  it('发给别的画布的 apply 一律忽略，不回执', async () => {
    await mountEditor('d1');
    const cb = harness.listeners.get('app:drawing-apply')!;
    await act(async () => {
      cb({ drawingId: 'other', opId: 'op-x', skeletons: [{ type: 'rectangle', id: 'n', x: 0, y: 0, width: 1, height: 1 }] });
      await Promise.resolve();
    });
    expect(harness.applied).toHaveLength(0);
  });

  it('转换失败时回执 ok:false 且带原因（不能谎报成功）', async () => {
    await mountEditor('d1');
    excalMock.convertToExcalidrawElements.mockImplementationOnce(() => {
      throw new Error('bad skeleton');
    });
    const cb = harness.listeners.get('app:drawing-apply')!;
    await act(async () => {
      cb({
        drawingId: 'd1',
        opId: 'op-2',
        skeletons: [{ type: 'rectangle', id: 'n', x: 0, y: 0, width: 1, height: 1 }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.applied[0]!.ok).toBe(false);
    expect(harness.applied[0]!.error).toContain('bad skeleton');
  });
});