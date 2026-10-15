import { describe, it, expect, vi } from 'vitest';
import { drawingRenderContent, renderDrawingForModel } from '../../src/main/drawing/render';

describe('drawing_render images', () => {
  it('将 PNG 写入附件并作为真正的图片块返回，不把 base64 放进文本', async () => {
    const image = { attachmentId: 'image-id', mediaType: 'image/png', width: 100, height: 50, bytes: 8 };
    const saveImage = vi.fn().mockResolvedValue(image);
    const saveRender = vi.fn().mockReturnValue('/task/thumbs/d.render.png');
    const value = await renderDrawingForModel('d', {
      drawings: { get: () => ({ id: 'd', todoId: 't', title: '架构图' }), saveRender },
      host: { exportDrawing: vi.fn().mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }) },
      attachments: { saveImage },
    } as never);
    expect(saveImage.mock.calls[0]![0].data).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(saveRender).toHaveBeenCalledWith('d', expect.any(Buffer));
    const content = drawingRenderContent({}, value);
    expect(content[1]).toEqual({ type: 'image', attachment: image });
    expect(content[0]?.text).not.toContain('base64');
  });
  it('导出失败不能保存或返回伪图片', async () => {
    const saveImage = vi.fn();
    await expect(renderDrawingForModel('d', { drawings: { get: () => ({ todoId: 't' }) },
      host: { exportDrawing: async () => ({ ok: false, error: '绘图为空' }) }, attachments: { saveImage } } as never)).rejects.toThrow('绘图为空');
    expect(saveImage).not.toHaveBeenCalled();
  });
});
