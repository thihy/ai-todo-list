// ExcalidrawEditor — reusable Excalidraw canvas for a single drawing.
//
// Extracted from DrawingPane so the same mount logic can be embedded inside
// the DocumentsView drawing tab (in-place editing) AND inside the legacy
// DrawingPane route. The canvas lazily imports @excalidraw/excalidraw to
// keep startup snappy and uses an imperative createRoot mount (Excalidraw's
// own React tree, not ours) so its internal state survives unmount-free
// re-renders.

import React, { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDrawing } from '../hooks/useTodoListApi';

export const ExcalidrawEditor: React.FC<{
  /** Parent task — required so autosave knows which TODO this drawing belongs to. */
  todoId: string;
  drawingId: string;
  className?: string;
  /** Save handler. Defaults to autosave on every change (600ms debounce).
   *  Override for special flows (e.g. explicit save). */
  onSave?: (drawingId: string, scene: { elements?: unknown; appState?: unknown }) => void;
}> = ({ todoId, drawingId, className, onSave }) => {
  const { scene } = useDrawing(drawingId);
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);

  useEffect(() => {
    if (!drawingId || !scene || !hostRef.current) return;
    let cancelled = false;
    (async () => {
      const mod = await import('@excalidraw/excalidraw');
      if (cancelled || !hostRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Excalidraw = (mod as any).Excalidraw;
      // Tear down any prior root (drawingId changed mid-mount).
      if (rootRef.current) rootRef.current.unmount();
      hostRef.current.innerHTML = '';
      const root = createRoot(hostRef.current);
      rootRef.current = root;
      const save = onSave ?? ((id, s) => defaultSave(todoId, id, s));
      root.render(
        React.createElement(Excalidraw, {
          initialData: scene,
          onChange: debounced(async (els, st) => {
            await save(drawingId, { elements: els, appState: st });
          }, 600),
        }),
      );
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('excalidraw load failed', err);
    });
    return () => {
      cancelled = true;
      if (rootRef.current) {
        rootRef.current.unmount();
        rootRef.current = null;
      }
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [drawingId, scene, todoId, onSave]);

  return (
    <div
      ref={hostRef}
      className={className}
      aria-label="绘图画布"
    />
  );
};

/** Default autosave target — writes through the standard drawing.save IPC. */
async function defaultSave(
  todoId: string,
  drawingId: string,
  scene: { elements?: unknown; appState?: unknown },
): Promise<void> {
  await window.todoList.drawing.save(todoId, scene as never, drawingId);
}

function debounced<T extends (...args: never[]) => unknown>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...(args as never[])), ms);
  }) as unknown as T;
}