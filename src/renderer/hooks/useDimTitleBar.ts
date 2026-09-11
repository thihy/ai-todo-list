// Drive the dim/restore IPC for the frameless titleBarOverlay whenever
// the calling component considers itself "covering" the app (a modal is
// open, a fullscreen editor is mounted, etc.). Idempotent — repeats with
// the same value are no-ops on the main side, and React's effect deps
// avoid the redundant call anyway. Always restores on unmount so a hot
// reload / route swap can't leave the overlay stuck dim.
//
// Why an IPC: titleBarOverlay is rendered by Chromium ABOVE the
// renderer's webContents, so renderer-side CSS can't touch it — main has
// to call setTitleBarOverlay() for the colour to actually change.

import { useEffect } from 'react';

export function useDimTitleBar(dim: boolean): void {
  useEffect(() => {
    void window.todoList.app.setTitleBarOverlay({ dim });
    return () => {
      // Restore on unmount regardless of `dim` (a parent that re-mounts
      // us mid-modal shouldn't leave the native chrome stuck dark).
      void window.todoList.app.setTitleBarOverlay({ dim: false });
    };
  }, [dim]);
}
