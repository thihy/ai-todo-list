// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
const mock = vi.hoisted(() => ({ exportToBlob: vi.fn() }));
vi.mock('@excalidraw/excalidraw', () => mock);
import { exportDrawingPng } from '../../src/renderer/drawing/export';

afterEach(() => { vi.unstubAllGlobals(); mock.exportToBlob.mockReset(); });
describe('full scene PNG export', () => {
  it('导出所有有效元素和嵌入图片，限制像素尺寸且不改变场景', async () => {
    const elements = [{ id: 'a', x: 0 }, { id: 'offscreen', x: 10000 }, { id: 'deleted', isDeleted: true }];
    const files = { embedded: { dataURL: 'image' } };
    const updateScene = vi.fn();
    mock.exportToBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2048, height: 1000, close }));
    const image = await exportDrawingPng({ getSceneElements: () => elements,
      getAppState: () => ({ selectedElementIds: { a: true } }), getFiles: () => files, updateScene });
    expect(mock.exportToBlob).toHaveBeenCalledWith(expect.objectContaining({ elements: elements.slice(0, 2), files,
      maxWidthOrHeight: 2048, mimeType: 'image/png', appState: expect.objectContaining({ exportBackground: true }) }));
    expect(image).toMatchObject({ width: 2048, height: 1000, dataUrl: expect.stringContaining('data:image/png;base64,') });
    expect(updateScene).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
  it('空画布和未就绪画布明确失败', async () => {
    const api = { getSceneElements: () => [], getAppState: () => ({}), updateScene: vi.fn() };
    await expect(exportDrawingPng(api)).rejects.toThrow('绘图为空');
    await expect(exportDrawingPng({ ...api, getAppState: () => ({ isLoading: true }) })).rejects.toThrow('尚未就绪');
    expect(mock.exportToBlob).not.toHaveBeenCalled();
  });
});
