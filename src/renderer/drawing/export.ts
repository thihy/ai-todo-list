import { exportToBlob } from '@excalidraw/excalidraw';
import type { MinimalExcalidrawApi } from './apply';

/** Export scene bounds, including content outside the viewport and embedded images. */
export async function exportDrawingPng(api: MinimalExcalidrawApi): Promise<{ dataUrl: string; width: number; height: number }> {
  if (api.getAppState().isLoading === true) throw new Error('画布尚未就绪。');
  const elements = api.getSceneElements().filter((element) => !(element as { isDeleted?: boolean }).isDeleted);
  if (!elements.length) throw new Error('绘图为空，没有可导出的内容。');
  await document.fonts?.ready;
  const blob = await exportToBlob({
    elements: elements as never,
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
    files: (api.getFiles?.() ?? {}) as never,
    mimeType: 'image/png',
    maxWidthOrHeight: 2048,
    exportPadding: 24,
  });
  if (blob.size > 20 * 1024 * 1024) throw new Error('绘图导出图片超过 20 MB，请简化绘图后重试。');
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取导出图片失败。'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, width, height };
}
