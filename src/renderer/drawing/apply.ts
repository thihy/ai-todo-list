// AI 绘图指令在渲染进程的应用（与 ExcalidrawEditor 解耦，便于单测）。
//
// 这一层是整个 B 版的收口点：main 送来的是**骨架**（只有 type/x/y/width/
// height/points/绑定 id），真正的 Excalidraw 元素字段由官方
// convertToExcalidrawElements 补齐 —— versionNonce / seed / version / index
// 这些我们一行都不手写，也就不会随 Excalidraw 升级而失效。
//
// 两个刻意的决定：
//
// 1) **显式落盘，不靠 onChange。** updateScene 是否触发 onChange 没有公开
//    保证，而 main 的工具把 ok 建立在回执上。所以这里在 updateScene 之后
//    直接调 save() 把场景写进磁盘，再回执 —— 「AI 说画好了」必须等于
//    「文件里真的有」。
//
// 2) **captureUpdate 用 NEVER。** 官方注释：远程更新 / 场景初始化用这个，
//    不进 undo 栈。AI 的绘制如果能 Ctrl+Z 撤销，会让用户以为自己画的
//    东西没了。

import { convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { DrawingSkeleton } from '../../shared/drawing-spec';
import { drawingDocumentState } from './scene-state';

/** Excalidraw 的 imperative API —— 只声明我们真正用到的方法。 */
export interface MinimalExcalidrawApi {
  updateScene(sceneData: {
    elements?: unknown[];
    appState?: Record<string, unknown> | null;
    collaborators?: unknown;
    captureUpdate?: unknown;
  }): void;
  getSceneElements(): unknown[];
  getAppState(): Record<string, unknown>;
  getFiles?(): Record<string, unknown>;
  addFiles?(files: unknown[]): void;
  scrollToContent?(elements: unknown[], opts?: Record<string, unknown>): void;
}

/** 落盘回调（ExcalidrawEditor 传自己的 save）。 */
export type SceneSaver = (
  drawingId: string,
  scene: { elements?: unknown; appState?: unknown; files?: unknown },
) => Promise<void> | void;

/** viewport 尺寸类字段不该进磁盘 —— 见 ExcalidrawEditor 的同名函数。 */
const stripHostDimensions = drawingDocumentState;

/**
 * 把一批骨架元素追加到画布并落盘。
 * **永不抛异常** —— 失败时返回 {ok:false, error}，由调用方回执给 main。
 */
export async function applySkeletonBatch(opts: {
  api: MinimalExcalidrawApi;
  drawingId: string;
  skeletons: DrawingSkeleton[];
  save: SceneSaver;
  scrollToContent?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { api, drawingId, skeletons, save, scrollToContent } = opts;
  try {
    if (!Array.isArray(skeletons) || skeletons.length === 0) {
      return { ok: false, error: '骨架列表为空。' };
    }
    const supported = new Set(['rectangle', 'ellipse', 'diamond', 'arrow', 'text']);
    const ids = new Set<string>();
    for (const element of skeletons) {
      if (!element || !element.id || !supported.has(element.type)) {
        return { ok: false, error: `无效绘图元素：${element?.id ?? '缺少 id'}，不支持的类型 ${element?.type ?? '缺少 type'}。` };
      }
      if (ids.has(element.id)) return { ok: false, error: `绘图元素 id 重复：${element.id}` };
      ids.add(element.id);
    }
    for (const element of skeletons) {
      for (const endpoint of [element.start, element.end]) {
        if (endpoint && !ids.has(endpoint.id)) return { ok: false, error: `连线 ${element.id} 引用了不存在的节点：${endpoint.id}` };
      }
    }

    const existing = (api.getSceneElements?.() ?? []) as unknown[];

    // 官方转换：补齐 versionNonce / seed / version / index，并为带 label 的
    // 容器自动生成绑定文本元素。regenerateIds:false 是刻意的 —— 我们已经给
    // 了稳定 id（ai-node-N），边靠这些 id 绑定端点；重新生成会让 start/end
    // 的引用落空。
    const usedIds = new Set(existing.map((element) => (element as { id?: string }).id));
    const remappedIds = new Map(skeletons.map((element) => [element.id,
      usedIds.has(element.id) ? `${element.id}-${crypto.randomUUID()}` : element.id]));
    const batch = skeletons.map((element) => ({
      ...element,
      id: remappedIds.get(element.id)!,
      ...(element.start ? { start: { id: remappedIds.get(element.start.id) ?? element.start.id } } : {}),
      ...(element.end ? { end: { id: remappedIds.get(element.end.id) ?? element.end.id } } : {}),
    }));
    const created = convertToExcalidrawElements(batch as never, {
      regenerateIds: false,
    });

    const merged = [...existing, ...(created as unknown[])];

    api.updateScene(
      { elements: merged, collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER },
    );

    if (scrollToContent && typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent(merged as never);
      } catch {
        // 视口滚动是纯体验增强，失败不该让绘制整体失败。
      }
    }

    // 显式落盘：updateScene 之后立刻用 API 读回真实场景再存，
    // 避免存到「还没应用完」的中间状态。
    const finalElements = (api.getSceneElements?.() ?? merged) as unknown[];
    const finalAppState = stripHostDimensions(api.getAppState?.() ?? {});
    await save(drawingId, { elements: finalElements, appState: finalAppState, files: api.getFiles?.() });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}
