// Drawing pane — hosts Excalidraw for one TODO.

import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useDrawing, useDrawings } from '../hooks/useThihyApi';

export const DrawingPane: React.FC<{
  todoId: string;
  drawingId?: string;
  navigate: (to: string) => void;
}> = ({ todoId, drawingId, navigate }) => {
  const { drawings, refresh } = useDrawings(todoId);
  const activeId = drawingId ?? drawings[0]?.id ?? null;
  const { scene } = useDrawing(activeId);
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazy-load Excalidraw only on first paint to keep startup snappy.
  useEffect(() => {
    if (!activeId || !scene || !containerRef.current) return;
    let cancelled = false;
    (async () => {
      const mod = await import('@excalidraw/excalidraw');
      if (cancelled || !containerRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Excalidraw = (mod as any).Excalidraw;
      const root = createRoot(containerRef.current);
      root.render(
        React.createElement(Excalidraw, {
          initialData: scene,
          onChange: debounced(async (els, st) => {
            await window.thihy.drawing.save(todoId, { elements: els, appState: st }, activeId);
          }, 600),
        }),
      );
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('excalidraw load failed', err);
    });
    return () => {
      cancelled = true;
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [activeId, scene, todoId]);

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
          onClick={async () => {
            const res = await window.thihy.drawing.save(todoId, { elements: [], appState: {} }, undefined, '新绘图');
            if (res.ok) {
              await refresh();
              const d = res.data as { id: string };
              navigate(`#/todo/${todoId}/drawing/${d.id}`);
            }
          }}
          style={{
            padding: 'var(--space-xs) var(--space-sm)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--fg-primary)',
            marginTop: 'var(--space-sm)',
          }}
        >
          + 新绘图
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
      <div
        ref={containerRef}
        style={{ background: 'var(--bg-canvas)' }}
        aria-label="绘图画布"
      />
    </div>
  );
};

function debounced<T extends (...args: never[]) => unknown>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...(args as never[])), ms);
  }) as unknown as T;
}