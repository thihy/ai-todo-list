// usePaneWidths — persisted widths for the resizable 3-pane layout.
//
// Two knobs: the user has a *basis* (their preferred open width, in px,
// persisted via localStorage). The *derived* width is what actually gets
// applied — it tracks the basis, but scales with the viewport so the
// three columns stay in proportion when the window grows or shrinks.
//
// Why scale at all? Without it the AI / list panes stay at the basis
// pixels even when the window triples in width, leaving the detail pane
// absurdly wide and the side columns oddly narrow. With scaling the
// side panes grow with the viewport (up to MAX) and stay at MIN when
// the window can't afford them.
//
// The user keeps full control: dragging a divider calls setListWidth /
// setAiWidth, which updates the basis. The next resize event then
// derives from the new basis. We deliberately do NOT write the derived
// value back into localStorage — only the basis is persisted, so a
// later restart with a different window size doesn't snap the panes
// to whatever the previous window happened to be.

import { useCallback, useEffect, useState } from 'react';

const LIST_KEY = 'todo-list.pane.listW';
const AI_KEY = 'todo-list.pane.aiW';

const LIST_DEFAULT = 340;
const AI_DEFAULT = 384;

const LIST_MIN = 240;
const LIST_MAX = 560;
const AI_MIN = 280;
const AI_MAX = 720;

// Viewport width at which the panes are sized at their default basis
// values — below this we clamp the sides to MIN, above this we let
// them grow (still capped at MAX). 1280 matches the default Electron
// window size for this app.
const DESIGN_VIEWPORT_W = 1280;

// Detail pane must stay at least this wide so the editor isn't crushed
// at small window sizes; used to decide whether to clamp the sides.
const DETAIL_MIN = 360;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function readNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max);
  } catch {
    return fallback;
  }
}

/** Derive an actual pane width from the user's preferred basis and the
 *  current viewport width. The basis is the "ideal" width at DESIGN_VIEWPORT_W.
 *  Above that, the pane grows in proportion (capped at MAX). Below, it
 *  shrinks proportionally until it hits MIN, at which point we stop —
 *  we never let the side pane crush the detail pane below DETAIL_MIN. */
function deriveWidth(
  basis: number,
  viewportW: number,
  min: number,
  max: number,
  otherMin: number,
): number {
  if (viewportW <= DESIGN_VIEWPORT_W) {
    // Below design size: shrink proportionally from basis toward MIN,
    // but only as far as the window actually has room for both sides
    // plus the detail pane.
    const ratio = viewportW / DESIGN_VIEWPORT_W;
    const minAvailableForSide = Math.max(
      min,
      // Leave room for the other side's MIN and DETAIL_MIN.
      Math.floor((viewportW - otherMin - DETAIL_MIN) * (basis / (basis + (otherMin || 1)))),
    );
    return clamp(Math.round(basis * ratio), minAvailableForSide, max);
  }
  // Above design size: grow proportionally, capped at MAX.
  const ratio = viewportW / DESIGN_VIEWPORT_W;
  return clamp(Math.round(basis * ratio), min, max);
}

/** Window.innerWidth is the only signal the renderer has; reading it
 *  during render is fine (no DOM access), and `resize` is the only
 *  event we need. SSR-safety: guard `typeof window === 'undefined'`. */
function readViewport(): number {
  if (typeof window === 'undefined') return DESIGN_VIEWPORT_W;
  return window.innerWidth || DESIGN_VIEWPORT_W;
}

export function usePaneWidths(): {
  listWidth: number;
  aiWidth: number;
  setListWidth: (next: number) => void;
  setAiWidth: (next: number) => void;
} {
  const [listBasis, setListBasis] = useState<number>(() =>
    readNum(LIST_KEY, LIST_DEFAULT, LIST_MIN, LIST_MAX),
  );
  const [aiBasis, setAiBasis] = useState<number>(() =>
    readNum(AI_KEY, AI_DEFAULT, AI_MIN, AI_MAX),
  );
  const [viewportW, setViewportW] = useState<number>(() => readViewport());

  // Keep the basis persisted. Note we deliberately do NOT persist the
  // derived width — only the basis survives restarts. See file header.
  useEffect(() => {
    try {
      localStorage.setItem(LIST_KEY, String(listBasis));
    } catch {
      /* ignore */
    }
  }, [listBasis]);
  useEffect(() => {
    try {
      localStorage.setItem(AI_KEY, String(aiBasis));
    } catch {
      /* ignore */
    }
  }, [aiBasis]);

  // Track viewport size so we can rescale side panes. We use rAF to
  // coalesce rapid resize events (e.g. dragging a window edge); without
  // it a window resize can fire many events per second and re-render the
  // entire layout each time.
  useEffect(() => {
    let frame = 0;
    const onResize = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        setViewportW(readViewport());
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const setListWidth = useCallback((next: number) => {
    setListBasis(clamp(next, LIST_MIN, LIST_MAX));
  }, []);
  const setAiWidth = useCallback((next: number) => {
    setAiBasis(clamp(next, AI_MIN, AI_MAX));
  }, []);

  const listWidth = deriveWidth(listBasis, viewportW, LIST_MIN, LIST_MAX, AI_MIN);
  const aiWidth = deriveWidth(aiBasis, viewportW, AI_MIN, AI_MAX, LIST_MIN);

  return { listWidth, aiWidth, setListWidth, setAiWidth };
}
