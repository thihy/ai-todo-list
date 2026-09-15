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

// Excalidraw's vendor CSS. The package ships its CSS as a separate
// `index.css` entry (not auto-injected by the JS bundle), so it must be
// imported explicitly — otherwise `.excalidraw` has no `height: 100%` /
// `overflow: hidden` and grows to its content height (the canvas's inline
// `style.height`). That creates a feedback loop: a transient measurement
// during a layout transition gets baked into `state.height`, the next
// paint pushes the canvas to that height, `.excalidraw` follows, and
// `updateDOMRect` reads it back — in practice ballooning to 19M px and
// rendering every toolbar icon / shape at the same gigantic scale.
// Loading this CSS gives `.excalidraw` its `height: 100%; overflow: hidden`
// rules so the host's bounded height (`.docs-workspace__excalidraw`'s
// `height: 600px`) is what `updateDOMRect` reads back.
import '@excalidraw/excalidraw/index.css';

// Strip esm.sh url() entries from any FontFace src so Excalidraw (which
// unconditionally appends its esm.sh ASSETS_FALLBACK_URL as a fallback src
// for every canvas font) never asks the browser to fetch from esm.sh — that
// attempt is what CSP `font-src` blocks and logs per font per variant.
// Idempotent: patches window.FontFace exactly once across remounts.
let excalFontFaceFilterInstalled = false;
function installExcalidrawFontFaceFilter(): void {
  if (excalFontFaceFilterInstalled || typeof window.FontFace !== 'function') return;
  excalFontFaceFilterInstalled = true;
  const Native = window.FontFace;
  const wrapper = function FontFace(
    this: unknown,
    family: string,
    source: string,
    descriptors?: FontFaceDescriptors,
  ): FontFace {
    const cleaned = stripEsmShFromSrc(typeof source === 'string' ? source : String(source));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Native as any)(family, cleaned, descriptors) as FontFace;
  } as unknown as typeof FontFace;
  // Keep `instanceof window.FontFace` true for the native instances we
  // return (their prototype chain is Native.prototype).
  (wrapper as unknown as { prototype: unknown }).prototype = Native.prototype;
  (window as unknown as { FontFace: typeof FontFace }).FontFace = wrapper;
}

// A FontFace src is a comma-separated list of `url(...) format(...)` entries.
// Drop any entry whose url() points at esm.sh. If that would empty the list
// (no local entry present), leave the source untouched so we never hand the
// native constructor an invalid empty src.
function stripEsmShFromSrc(source: string): string {
  const parts = source.split(',').map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((p) => !/esm\.sh\//.test(p));
  return kept.length > 0 ? kept.join(', ') : source;
}

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
      // Must be set before import('@excalidraw/excalidraw'): excalidraw reads
      // ASSETS_FALLBACK_URL (default https://esm.sh/...) at module load and
      // uses it as the base for every font. Overriding the global routes all
      // canvas fonts (Assistant / Cascadia / Virgil / …) through the local
      // /excalidraw/fonts/ path. Font URIs already carry the fonts/ prefix,
      // so the base stops at /excalidraw/ — otherwise we'd get the double
      // /excalidraw/fonts/fonts/… that 404s and then the browser falls back
      // to esm.sh.
      //
      // Excalidraw's createUrls() unconditionally appends ASSETS_FALLBACK_URL
      // (esm.sh) as the LAST src entry of every FontFace, so even with the
      // local base set, each FontFace src is [local, esm.sh]. The browser
      // still attempts the esm.sh URL and CSP logs a font-src violation per
      // font per variant (Cascadia, every ComicShanns hash, …). To kill the
      // violations at the source we wrap window.FontFace once (before the
      // dynamic import) so that any esm.sh url() token is stripped from the
      // src string before the native FontFace is constructed. The wrapper
      // returns a genuine native FontFace instance (not a subclass — that
      // previously broke icon metrics because document.fonts.add / instanceof
      // behave differently on non-native instances), so Excalidraw's
      // .load() / .status / document.fonts.add all work transparently.
      installExcalidrawFontFaceFilter();
      const basePath = `${window.location.origin}/excalidraw/`;
      (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = basePath;
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
      // Excalidraw's runtime keeps appState.collaborators as a Map. A Map
      // collapses to {} through JSON.stringify on save, and on reload
      // InteractiveCanvas calls appState.collaborators.forEach on mount —
      // which throws "forEach is not a function" on the plain {}. We don't
      // persist collaborators (collaboration is off), so restore a fresh
      // empty Map on every mount.
      //
      // Strip host-container-derived dimensions from the loaded scene.
      // Excalidraw reads `appState.width`/`appState.height` (and the
      // matching offsets) as the **viewport size** on mount and applies
      // them directly to the canvas — these are NOT user state, they're
      // just cached container measurements. The renderer's host div sizes
      // the canvas, so the saved values are at best redundant and at worst
      // catastrophic: a transient measurement during a layout transition
      // (tab switch, fullscreen toggle) can persist a huge height to disk,
      // and the next mount re-applies it, blowing the canvas up to ~33M
      // buffer pixels with DPR=1.75 — every icon then renders gigantic
      // and is effectively off-screen. Reset to a fresh empty Map and let
      // Excalidraw re-measure the actual host on every mount.
      const appState = stripHostDimensions(scene.appState ?? {});
      const initialData = {
        elements: scene.elements ?? [],
        appState: { ...appState, collaborators: new Map() },
      };
      root.render(
        React.createElement(Excalidraw, {
          initialData,
          onChange: debounced(async (els, st) => {
            await save(drawingId, {
              elements: els,
              // Strip host-derived dimensions on save too: keeps the on-disk
              // scene free of viewport-sized numbers, so even if some other
              // code path reads the raw JSON it can't replay a corrupted
              // measurement. Excalidraw will repopulate these correctly on
              // the next onChange tick.
              appState: stripHostDimensions(st as Record<string, unknown>),
            });
          }, 600),
        }),
      );
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('excalidraw load failed', err);
    });
    return () => {
      cancelled = true;
      const root = rootRef.current;
      rootRef.current = null;
      const host = hostRef.current;
      if (root) {
        // Defer teardown to the next macrotask. This cleanup fires during the
        // parent's commit phase (tab switch re-renders DocumentsView), and
        // calling root.unmount() synchronously inside another React render
        // trips the "unmount while rendering" guard. The host div is about to
        // be detached by React anyway, so a one-tick delay is safe.
        setTimeout(() => {
          root.unmount();
          if (host) host.innerHTML = '';
        }, 0);
      } else if (host) {
        host.innerHTML = '';
      }
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

/** Drop the viewport-sized keys Excalidraw caches into appState. These
 *  describe the current canvas dimensions, not user content — they MUST be
 *  re-measured from the host container on every mount, never replayed from
 *  disk. See the comment above the load-site call site for the full story
 *  on why a saved `height` of ~19M blows the canvas up to 33M buffer pixels.
 *  Keep this list narrow: any future host-derived dimension (e.g. a new
 *  Excalidraw release that caches devicePixelRatio) belongs here too. */
function stripHostDimensions(
  appState: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(appState)) {
    if (
      k === 'width' ||
      k === 'height' ||
      k === 'offsetLeft' ||
      k === 'offsetTop'
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}