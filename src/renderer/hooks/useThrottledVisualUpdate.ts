// useThrottledVisualUpdate — rAF-throttled reflow for streaming text.
//
// The DSH web frontend exposes this hook from `@deepseek-ai/dsh-app-runtime`
// (not primitives). For AIPane we only need the "smooth updates during
// streaming" use case — collapse a burst of state changes into a single
// reflow per frame. Matches the pattern used in DSH ReasoningRow.tsx to keep
// the inline preview from flickering on every token.
//
// We always return the LATEST committed value at commit time, plus a
// `flushSync()` ref the caller can read between rAF boundaries when it
// must synchronously reflect the latest value (e.g. on scroll-into-view).

import { useEffect, useRef, useState } from 'react';

export function useThrottledVisualUpdate<T>(value: T): T {
  const [committed, setCommitted] = useState(value);
  const pending = useRef<T>(value);
  const raf = useRef<number | null>(null);
  // Mirror the latest into `pending` on every render — no state read needed.
  pending.current = value;
  useEffect(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      setCommitted(pending.current);
      raf.current = null;
    });
    return () => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
    };
  }, [value]);
  return committed;
}