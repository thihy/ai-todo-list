import { describe, expect, it } from 'vitest';
import { drawingDocumentState } from '../../src/renderer/drawing/scene-state';

describe('drawingDocumentState', () => {
  it('保留文档配置，过滤会恢复焦点陷阱和编辑会话的临时状态', () => {
    expect(drawingDocumentState({ viewBackgroundColor: '#fff', zoom: { value: 2 },
      openDialog: { name: 'help' }, editingTextElement: { id: 'text' },
      selectedElementIds: { text: true }, isLoading: true, width: 800,
      collaborators: new Map(), cursorButton: 'down',
    })).toEqual({ viewBackgroundColor: '#fff', zoom: { value: 2 } });
  });
});
