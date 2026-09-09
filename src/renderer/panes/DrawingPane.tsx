// Drawing pane — legacy standalone route wrapper around ExcalidrawEditor.
// Kept for deep links / back-compat (`#/todo/<id>/drawing/<id>`). The main
// drawing edit surface is now embedded in DocumentsView via ExcalidrawEditor.

import React, { useState } from 'react';
import { useDrawings } from '../hooks/useThihyApi';
import { ExcalidrawEditor } from '../components/ExcalidrawEditor';

export const DrawingPane: React.FC<{
  todoId: string;
  drawingId?: string;
  navigate: (to: string) => void;
}> = ({ todoId, drawingId, navigate }) => {
  const { drawings, refresh } = useDrawings(todoId);
  const activeId = drawingId ?? drawings[0]?.id ?? null;
  const [creating, setCreating] = useState(false);

  const onNew = async (): Promise<void> => {
    setCreating(true);
    try {
      const res = await window.thihy.drawing.save(todoId, { elements: [], appState: {} }, undefined, '新绘图');
      if (res.ok) {
        await refresh();
        const d = res.data as { id: string };
        navigate(`#/todo/${todoId}/drawing/${d.id}`);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', height: '100%' }}>
      <aside
        style={{
          padding: 'var(--space-md)',
          borderRight: '1px solid var(--border-default)',
          background: 'var(--bg-surface)',
          overflow: 'auto',
        }}
      >
        <button
          type="button"
          onClick={() => navigate(`#/todo/${todoId}`)}
          style={{ color: 'var(--fg-muted)', fontSize: 'var(--font-sm)' }}
        >
          ← 返回 TODO
        </button>
        <h3 style={{ marginTop: 'var(--space-md)' }}>绘图</h3>
        <button
          type="button"
          onClick={() => void onNew()}
          disabled={creating}
          style={{
            padding: 'var(--space-xs) var(--space-sm)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--fg-primary)',
            marginTop: 'var(--space-sm)',
          }}
        >
          {creating ? '创建中…' : '+ 新绘图'}
        </button>
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-md)' }}>
          {drawings.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => navigate(`#/todo/${todoId}/drawing/${d.id}`)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 'var(--space-sm)',
                  borderRadius: 'var(--radius-md)',
                  background: d.id === activeId ? 'var(--bg-surface-elev)' : 'transparent',
                  color: 'var(--fg-primary)',
                }}
              >
                {d.title || '(无标题)'}
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-muted)' }}>
                  {new Date(d.updatedAt).toLocaleString()}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {activeId ? (
        <ExcalidrawEditor todoId={todoId} drawingId={activeId} className="drawing-pane__canvas" />
      ) : (
        <div style={{ padding: 'var(--space-xl)', color: 'var(--fg-muted)' }}>
          还没有绘图。点击「+ 新绘图」创建。
        </div>
      )}
    </div>
  );
};