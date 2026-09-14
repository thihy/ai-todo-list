// PaneDivider — a thin vertical drag handle between two horizontal panes.
// `onDrag(deltaX)` fires on every mousemove during a drag; the caller decides
// the sign (whether dragging right grows or shrinks the pane on its left). The
// divider captures the pointer and attaches window listeners so the drag
// keeps tracking even when the cursor leaves the handle.

import React, { useCallback, useEffect, useRef } from 'react';

export const PaneDivider: React.FC<{ onDrag: (deltaX: number) => void }> = ({ onDrag }) => {
  const dragging = useRef(false);
  const lastX = useRef(0);
  // Keep the latest onDrag in a ref so the move/up listeners bind ONCE. The
  // parent passes a new arrow each render, so putting onDrag in the effect
  // deps re-bound window listeners on every re-render — and the
  // remove/addEventListener pair between renders dropped mousemove frames,
  // so lastX fell behind the cursor and the next delta jumped (visibly
  // stuttering + lagging the mouse). The ref closure always reads the
  // freshest callback without touching the effect.
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      if (dx !== 0) onDragRef.current(dx);
    };
    const onUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整宽度"
      onMouseDown={onMouseDown}
    />
  );
};
