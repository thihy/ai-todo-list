// useFocusSync — push the renderer's "what's currently open" pointer to the
// main process so the AI's `app.currentContext` tool can ground its answers.
//
// The most-recent push wins (the main side is a singleton, last-write-wins).
// Multiple components can call this with different specificity — e.g. App
// pushes a task-level focus on select, DocumentsView overrides with a
// document/drawing focus when a tab is picked. The later, more-specific
// push replaces the broader one until it changes.

import { useEffect, useRef } from 'react';
import type { AppFocus } from '../../shared/thihy-api';

export function useFocusSync(focus: AppFocus | null): void {
  // Dedupe: only push when the focus actually changes (deep-equal cheap
  // check). Without this, every parent re-render would re-push the same
  // payload across IPC.
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = focus ? JSON.stringify(focus) : null;
    if (serialized === lastRef.current) return;
    lastRef.current = serialized;
    void window.thihy.app.setFocus(focus).catch(() => {
      // Best-effort: the AI tool degrades gracefully if main can't be
      // reached. Don't surface an error — focus sync is invisible plumbing.
    });
  }, [focus]);
}