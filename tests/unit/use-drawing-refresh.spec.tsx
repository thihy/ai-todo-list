// @vitest-environment happy-dom
//
// useDrawing 必须随 AI 的绘图写入刷新 —— 回归测试。
//
// 事故本体：AI 的 `drawing_save` 走 main 的 mutatingScopes 广播 `'drawings'`，
// 但渲染端一开始只有 useDrawings（列表）订阅这个 scope，useDrawing（打开中
// 的画布）只依赖 `[id]`。症状极具迷惑性：
//
//   1. AI 写完场景 → 绘图**列表**刷新了，打开的**画布**还是旧画面；
//   2. 用户没察觉，在画布上随手画一笔；
//   3. ExcalidrawEditor 的 600ms autosave 把整份场景回写，AI 的内容被覆盖。
//
// 纯人工操作下这条路径根本走不到（用户自己画、自己存，看到的就是最新的），
// 所以这个 bug 可以在代码里躺很久，直到 DSH 开始直接操作绘图才爆出来。
//
// 这里用真实的 data-bus（不是 mock 的 useDataVersion），端到端验证
// 「emitDataChanged('drawings') → 画布重新拉取场景」，因为回归点正是
// 「订阅漏了」这条连线本身 —— mock 掉 useDataVersion 就等于把被测的东西
// 也 mock 掉了。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 让 React 知道我们在 act() 里驱动状态更新，否则每次 act 都会打
// "The current testing environment is not configured to support act(...)"。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { emitDataChanged } from '../../src/renderer/data-bus';
import { useDrawing } from '../../src/renderer/hooks/useTodoListApi';

// window.todoList.drawing.read 的桩：记录每次被调用的次数，返回可变的场景。
const harness = vi.hoisted(() => ({ readCalls: 0, scene: { elements: [], appState: {} } }));

beforeEach(() => {
  harness.readCalls = 0;
  harness.scene = { elements: [], appState: {} };
  (globalThis as unknown as { window: Record<string, unknown> }).window.todoList = {
    drawing: {
      read: vi.fn(() => {
        harness.readCalls += 1;
        return Promise.resolve({ ok: true, data: harness.scene });
      }),
    },
  };
});

let container: HTMLDivElement;
let root: Root;

/** 让 pending 的 promise（drawing.read）落地并触发 React 状态更新。
 *  useDrawing 是异步拉取的：render 那一刻 scene 还是 null，断言必须等
 *  微任务队列排空、setScene 跑完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 挂一个只调用 useDrawing(id) 的探针，把读到的场景暴露出来。 */
function mountProbe(drawingId: string | null, onScene: (scene: unknown) => void): void {
  const Probe: React.FC = () => {
    const { scene } = useDrawing(drawingId);
    onScene(scene);
    return null;
  };
  act(() => root.render(<Probe />));
}

describe('useDrawing 随 drawings scope 变更重拉场景', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('挂载时读一次场景', async () => {
    const seen: unknown[] = [];
    mountProbe('drawing-1', (s) => seen.push(s));
    await flush();
    expect(harness.readCalls).toBe(1);
    expect(seen.at(-1)).toEqual({ elements: [], appState: {} });
  });

  it("emitDataChanged('drawings') 之后重新读场景 —— AI 写完画布能看见", async () => {
    const seen: unknown[] = [];
    mountProbe('drawing-1', (s) => seen.push(s));
    await flush();
    expect(harness.readCalls).toBe(1);

    // AI 写了一份新场景（元素带上了 marker），然后广播。
    harness.scene = { elements: [{ id: 'ai-shape', type: 'rectangle' }], appState: {} };
    await act(async () => {
      emitDataChanged('drawings');
      await Promise.resolve();
    });

    expect(harness.readCalls).toBe(2);
    expect(seen.at(-1)).toEqual({
      elements: [{ id: 'ai-shape', type: 'rectangle' }],
      appState: {},
    });
  });

  it("emitDataChanged('todos') 不会触发重拉 —— 作用域是隔离的", async () => {
    mountProbe('drawing-1', () => undefined);
    await flush();
    expect(harness.readCalls).toBe(1);

    await act(async () => {
      emitDataChanged('todos');
      await Promise.resolve();
    });
    expect(harness.readCalls).toBe(1);
    await act(async () => {
      emitDataChanged('content');
      await Promise.resolve();
    });
    expect(harness.readCalls).toBe(1);
  });

  it('id 为 null 时不读盘，且清空已有场景', async () => {
    const seen: unknown[] = [];
    mountProbe('drawing-1', (s) => seen.push(s));
    await flush();
    expect(harness.readCalls).toBe(1);

    mountProbe(null, (s) => seen.push(s));
    await flush();
    expect(harness.readCalls).toBe(1);
    expect(seen.at(-1)).toBeNull();
  });

  it('切换 drawing id 会重新读新场景', async () => {
    mountProbe('drawing-1', () => undefined);
    await flush();
    mountProbe('drawing-2', () => undefined);
    await flush();
    expect(harness.readCalls).toBe(2);
  });
});
