// AI 绘图指令在渲染进程的应用 —— 单元测试。
//
// 覆盖的是三条**不能回退**的性质：
//
// 1. 追加而不是替换 —— 已有元素必须保留，否则 AI 往一张画了半张的画布上
//    补图时会把用户的笔迹整张抹掉。
// 2. **显式落盘** —— 不能指望 updateScene 触发 onChange（那条路没有公开
//    保证）。main 的工具把 ok 建立在回执上，而回执建立在「文件里真的有」
//    上，所以 save 必须被调用，且存的是应用之后的场景。
// 3. 失败不抛异常 —— Excalidraw 转换失败时要把原因带回去给 main，而不是
//    让整个 AI 轮次炸掉。
//
// Excalidraw 是浏览器包，这里用 vi.mock 顶掉，只保留真实的调用契约
// （updateScene / getSceneElements / getAppState / scrollToContent）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const excalMock = vi.hoisted(() => ({
  convertToExcalidrawElements: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
}));

vi.mock('@excalidraw/excalidraw', () => excalMock);

import { applySkeletonBatch, type MinimalExcalidrawApi } from '../../src/renderer/drawing/apply';
import type { DrawingSkeleton } from '../../src/shared/drawing-spec';

const SKELETONS: DrawingSkeleton[] = [
  { type: 'rectangle', id: 'ai-node-0', x: 0, y: 0, width: 180, height: 60, label: { text: '开始' } },
  {
    type: 'arrow',
    id: 'ai-edge-a',
    x: 180,
    y: 30,
    width: 80,
    height: 0,
    points: [[0, 0], [80, 0]],
    start: { id: 'ai-node-0' },
    end: { id: 'ai-node-0' },
  },
];

/** 假 Excalidraw API：updateScene 之后 getSceneElements 返回合并后的结果。 */
function makeApi(existing: unknown[] = []) {
  let current = existing;
  const calls: Array<Record<string, unknown>> = [];
  const api: MinimalExcalidrawApi & { calls: Array<Record<string, unknown>> } = {
    calls,
    updateScene(sceneData) {
      calls.push({ sceneData });
      current = (sceneData.elements as unknown[]) ?? current;
    },
    getSceneElements: () => current,
    getAppState: () => ({ gridSize: null, width: 1200, height: 800, offsetLeft: 0 }),
    scrollToContent: vi.fn(),
  };
  return api;
}

beforeEach(() => {
  excalMock.convertToExcalidrawElements.mockReset();
  // 默认：官方转换补齐字段后返回一个「完整元素」数组。
  excalMock.convertToExcalidrawElements.mockImplementation(
    (skeletons: Array<{ id: string }>) =>
      skeletons.map((s) => ({ ...s, version: 1, versionNonce: 7, seed: 1, index: 'a0' })),
  );
});

describe('applySkeletonBatch', () => {
  it('未知骨架类型在转换前明确失败，不调用画布和保存', async () => {
    const save = vi.fn();
    const api = makeApi();
    const result = await applySkeletonBatch({ api, drawingId: 'd1',
      skeletons: [{ ...SKELETONS[0]!, type: 'cylinder' } as never], save });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cylinder') });
    expect(excalMock.convertToExcalidrawElements).not.toHaveBeenCalled();
    expect(api.calls).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('断开的箭头引用在转换前明确失败', async () => {
    const result = await applySkeletonBatch({ api: makeApi(), drawingId: 'd1',
      skeletons: [{ ...SKELETONS[1]!, end: { id: 'missing' } }, SKELETONS[0]!], save: vi.fn() });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('missing') });
    expect(excalMock.convertToExcalidrawElements).not.toHaveBeenCalled();
  });
  it('把官方转换的结果追加进场景，而不是替换', async () => {
    const existing = [{ id: 'user-stroke', type: 'freedraw' }];
    const api = makeApi(existing);
    const save = vi.fn();

    const res = await applySkeletonBatch({
      api,
      drawingId: 'd1',
      skeletons: SKELETONS,
      save,
    });

    expect(res.ok).toBe(true);
    const merged = api.calls[0]!.sceneData as { elements: Array<{ id: string }> };
    expect(merged.elements.map((e) => e.id)).toEqual(['user-stroke', 'ai-node-0', 'ai-edge-a']);
  });

  it('regenerateIds 必须为 false —— 否则边的 start/end 绑定会落空', async () => {
    const api = makeApi();
    await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save: vi.fn() });
    expect(excalMock.convertToExcalidrawElements).toHaveBeenCalledWith(SKELETONS, {
      regenerateIds: false,
    });
  });

  it('连续追加时重命名冲突 ID，并同步重定向箭头绑定', async () => {
    const api = makeApi([{ id: 'ai-node-0' }]);
    const result = await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save: vi.fn() });
    expect(result.ok).toBe(true);
    const batch = excalMock.convertToExcalidrawElements.mock.calls[0]![0] as DrawingSkeleton[];
    expect(batch[0]!.id).not.toBe('ai-node-0');
    expect(batch[1]!.start!.id).toBe(batch[0]!.id);
    const ids = api.getSceneElements().map((element) => (element as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('显式落盘：save 被调用一次，且存的是应用后的完整场景', async () => {
    const api = makeApi([{ id: 'user-stroke' }]);
    const save = vi.fn();
    await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save });

    expect(save).toHaveBeenCalledTimes(1);
    const [savedId, scene] = save.mock.calls[0] as [string, { elements: Array<{ id: string }> }];
    expect(savedId).toBe('d1');
    expect(scene.elements.map((e) => e.id)).toEqual(['user-stroke', 'ai-node-0', 'ai-edge-a']);
  });

  it('落盘时剥掉 width/height/offset —— 那是视口尺寸不是内容', async () => {
    const api = makeApi();
    const save = vi.fn();
    await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save });
    const [, scene] = save.mock.calls[0] as [string, { appState: Record<string, unknown> }];
    expect(scene.appState).not.toHaveProperty('width');
    expect(scene.appState).not.toHaveProperty('height');
    expect(scene.appState).not.toHaveProperty('offsetLeft');
    expect(scene.appState).not.toHaveProperty('offsetTop');
    // 真正的 appState 状态要留着。
    expect(scene.appState).toHaveProperty('gridSize');
  });

  it('captureUpdate 用 NEVER —— AI 的绘制不进 undo 栈', async () => {
    const api = makeApi();
    await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save: vi.fn() });
    expect(api.calls[0]!.sceneData).toHaveProperty('captureUpdate', 'never');
  });

  it('collaborators 补一个空 Map —— 保持 Excalidraw 的运行时约定', async () => {
    const api = makeApi();
    await applySkeletonBatch({ api, drawingId: 'd1', skeletons: SKELETONS, save: vi.fn() });
    const scene = api.calls[0]!.sceneData as { collaborators: unknown };
    expect(scene.collaborators).toBeInstanceOf(Map);
  });

  it('scrollToContent 只在显式要求时调用', async () => {
    const withScroll = makeApi();
    await applySkeletonBatch({
      api: withScroll,
      drawingId: 'd1',
      skeletons: SKELETONS,
      save: vi.fn(),
      scrollToContent: true,
    });
    expect(withScroll.scrollToContent).toHaveBeenCalled();

    const without = makeApi();
    await applySkeletonBatch({ api: without, drawingId: 'd1', skeletons: SKELETONS, save: vi.fn() });
    expect(without.scrollToContent).not.toHaveBeenCalled();
  });

  it('scrollToContent 抛错不影响绘制结果（纯体验增强）', async () => {
    const api = makeApi();
    api.scrollToContent = vi.fn(() => {
      throw new Error('viewport gone');
    });
    const save = vi.fn();
    const res = await applySkeletonBatch({
      api,
      drawingId: 'd1',
      skeletons: SKELETONS,
      save,
      scrollToContent: true,
    });
    expect(res.ok).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it('骨架为空直接失败，不调官方转换也不落盘', async () => {
    const api = makeApi();
    const save = vi.fn();
    const res = await applySkeletonBatch({ api, drawingId: 'd1', skeletons: [], save });
    expect(res.ok).toBe(false);
    expect(excalMock.convertToExcalidrawElements).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('官方转换抛错时返回原因，不向上抛', async () => {
    excalMock.convertToExcalidrawElements.mockImplementation(() => {
      throw new Error('invalid skeleton');
    });
    const res = await applySkeletonBatch({
      api: makeApi(),
      drawingId: 'd1',
      skeletons: SKELETONS,
      save: vi.fn(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('invalid skeleton');
  });

  it('落盘失败也返回失败（不能谎报成功）', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const res = await applySkeletonBatch({
      api: makeApi(),
      drawingId: 'd1',
      skeletons: SKELETONS,
      save,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk full');
  });

  it('非数组骨架被拒绝', async () => {
    const res = await applySkeletonBatch({
      api: makeApi(),
      drawingId: 'd1',
      skeletons: null as never,
      save: vi.fn(),
    });
    expect(res.ok).toBe(false);
  });
});
