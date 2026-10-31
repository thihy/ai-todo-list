import type { LiveDrawingContext } from '../../shared/drawing-engine';

export const DRAWING_AI_SUBMIT_EVENT = 'todo-list:drawing-ai-submit';
export interface DrawingAnnotation { id: string; elementIds: string[]; text: string; versions: Record<string, number> }
export const annotationStorageKey = (drawingId: string) => `todo-list:drawing-annotations:${encodeURIComponent(drawingId)}`;
export function loadDrawingAnnotations(raw: string | null): DrawingAnnotation[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text.length <= 4000
      && Array.isArray(item.elementIds) && item.elementIds.length > 0 && item.elementIds.length <= 2000
      && item.elementIds.every((id: unknown) => typeof id === 'string') && item.versions && typeof item.versions === 'object').slice(0, 50);
  } catch { return []; }
}
export function annotationPrompt(drawingId: string, annotations: DrawingAnnotation[], live: LiveDrawingContext): string {
  if (live.drawingId !== drawingId) throw Error('画布已切换，请回到原绘图再提交。');
  const ids = new Set(live.elements.map(element => (element as { id: string }).id));
  const missing = annotations.findIndex(annotation => annotation.elementIds.some(id => !ids.has(id)));
  if (missing >= 0) throw Error(`第 ${missing + 1} 条标注的目标已被删除，请修改或删除这条标注后再提交。`);
  return `请批量处理这 ${annotations.length} 条绘图标注，仅修改指定绘图中对应的真实元素。先读取实时引擎核实目标和最新版本，保留其他元素及用户后续编辑；不要创建待办任务、重建整张画布或降级读写场景 JSON。\n绘图引用：${drawingId}\n提交时场景版本：${live.revision}\n\n${annotations.map((annotation, index) => `${index + 1}. ${annotation.text.trim()}\n   元素引用：${annotation.elementIds.join(', ')}`).join('\n\n')}`;
}
export function annotationPosition(bounds: [number, number, number, number], viewport: { width: number; height: number }) {
  const width = Math.min(280, Math.max(160, viewport.width - 24));
  const right = bounds[2] + 12;
  return { left: Math.max(12, Math.min(right + width <= viewport.width - 12 ? right : bounds[0] - width - 12, viewport.width - width - 12)),
    top: Math.max(64, Math.min(bounds[1], viewport.height - 170)), width };
}
