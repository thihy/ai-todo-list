import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { DrawingStore } from '../files/drawings';
import type { DrawingCanvasHost } from './canvas-host';

export interface DrawingRenderValue {
  drawingId: string;
  path: string;
  image: ImageAttachmentRef;
}

export async function renderDrawingForModel(id: string, deps: {
  drawings: DrawingStore;
  host: DrawingCanvasHost;
  attachments: AttachmentStore;
}): Promise<DrawingRenderValue> {
  const drawing = deps.drawings.get(id);
  if (!drawing) throw new Error(`找不到绘图：${id}`);
  const result = await deps.host.exportDrawing(drawing.todoId, id);
  if (!result.ok) throw new Error(result.error ?? '绘图导出失败');
  if (!result.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('画布没有返回 PNG 图片。');
  if (result.dataUrl.length > 28 * 1024 * 1024) throw new Error('绘图导出过大。');
  const data = Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64');
  const image = await deps.attachments.saveImage({ data, mediaType: 'image/png', name: `${drawing.title ?? '绘图'}.png` });
  const path = deps.drawings.saveRender(id, data);
  return { drawingId: id, path, image };
}

export function drawingRenderContent(_args: unknown, value: DrawingRenderValue) {
  return [
    { type: 'text' as const, text: `绘图 ${value.drawingId} 的完整渲染结果：${value.image.width} × ${value.image.height}。PNG 文件：${value.path}` },
    { type: 'image' as const, attachment: value.image },
  ];
}
