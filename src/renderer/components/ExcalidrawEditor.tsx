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
import { useToastBus } from './Toast';
import { useAppEvent } from '../hooks/useTodoListApi';
import { applySkeletonBatch, type MinimalExcalidrawApi, type SceneSaver } from '../drawing/apply';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { drawingDocumentState } from '../drawing/scene-state';
import { exportDrawingPng } from '../drawing/export';

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
  todoId: string;
  drawingId: string;
  className?: string;
  onSave?: SceneSaver;
}> = ({ todoId, drawingId, className, onSave }) => {
  const { scene, error } = useDrawing(drawingId);
  const toast = useToastBus();
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MinimalExcalidrawApi | null>(null);
  const latestScene = useRef(scene);
  latestScene.current = scene;
  const mountedScene = useRef(scene);
  const saveRef = useRef<SceneSaver>(() => {});
  saveRef.current = onSave ?? ((id, value) => defaultSave(todoId, id, value));
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const autosaveRef = useRef<{ cancel(): void } | null>(null);
  const sceneLoaded = scene !== null;
  const applyingRef = useRef(false);

  // External writes update the existing editor: remounting here can replace
  // focused DOM and leave a detached editor's global listeners behind.
  useEffect(() => {
    const api = apiRef.current;
    if (!scene || !api || api.getAppState().isLoading === true || mountedScene.current === scene) return;
    if (applyingRef.current) {
      mountedScene.current = scene;
      return;
    }
    autosaveRef.current?.cancel();
    mountedScene.current = scene;
    if (scene.files) api.addFiles?.(Object.values(scene.files));
    api.updateScene({
      elements: scene.elements,
      appState: drawingDocumentState(scene.appState ?? {}),
      collaborators: new Map(),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [scene]);

  useAppEvent('app:drawing-apply', (payload) => {
    if (payload.drawingId !== drawingId) return;
    const api = apiRef.current;
    autosaveRef.current?.cancel();
    void (async () => {
      applyingRef.current = true;
      const result = !api || api.getAppState().isLoading === true
        ? { ok: false, error: '画布尚未就绪。' }
        : await applySkeletonBatch({
            api, drawingId, skeletons: payload.skeletons,
            save: (id, value) => saveRef.current(id, value),
            scrollToContent: payload.scrollToContent,
          });
      applyingRef.current = false;
      await window.todoList.drawing.applied({
        opId: payload.opId, drawingId, ok: result.ok, error: result.error,
      });
      toastRef.current.push(result.ok
        ? { kind: 'success', message: 'AI 已绘制到画布', ttl: 1500 }
        : { kind: 'error', message: `AI 绘制失败：${result.error ?? '未知错误'}`, ttl: 3000 });
    })();
  });

  useAppEvent('app:drawing-export', (payload) => {
    if (payload.drawingId !== drawingId) return;
    const api = apiRef.current;
    void (async () => {
      try {
        if (!api) throw new Error('画布尚未就绪。');
        const image = await exportDrawingPng(api);
        await window.todoList.drawing.exported({ ...payload, ok: true, ...image });
      } catch (cause) {
        await window.todoList.drawing.exported({ ...payload, ok: false,
          error: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  });

  useEffect(() => {
    if (!drawingId || !sceneLoaded || !hostRef.current) return;
    let cancelled = false;
    let root: Root | null = null;
    let mountNode: HTMLDivElement | null = null;
    let ready = false;
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    let removeKeyDown: (() => void) | undefined;
    const autosave = debounced((elements: unknown[], state: Record<string, unknown>) => {
      if (cancelled || state.isLoading === true) return;
      void Promise.resolve(saveRef.current(drawingId, {
        elements, appState: drawingDocumentState(state), files: apiRef.current?.getFiles?.(),
      })).catch((error: unknown) => {
        toastRef.current.push({ kind: 'error', message: `保存绘图失败：${error instanceof Error ? error.message : String(error)}`, ttl: 3000 });
      });
    }, 600);
    autosaveRef.current = autosave;

    const reportReady = (): void => {
      if (cancelled || ready) return;
      const api = apiRef.current;
      if (!api || api.getAppState().isLoading === true) {
        readinessTimer = setTimeout(reportReady, 16);
        return;
      }
      const fresh = latestScene.current;
      if (fresh && fresh !== mountedScene.current) {
        mountedScene.current = fresh;
        if (fresh.files) api.addFiles?.(Object.values(fresh.files));
        api.updateScene({ elements: fresh.elements, appState: drawingDocumentState(fresh.appState ?? {}),
          collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER });
      }
      ready = true;
      void window.todoList.drawing.canvasReady({ drawingId });
    };

    void (async () => {
      (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';
      installExcalidrawFontFaceFilter();
      const mod = await import('@excalidraw/excalidraw');
      if (cancelled || !hostRef.current || !latestScene.current) return;
      // Each root owns a separate child. Deferred teardown can only remove
      // its old child, never clear a newer canvas mounted in the same host.
      mountNode = document.createElement('div');
      mountNode.style.height = '100%';
      hostRef.current.replaceChildren(mountNode);
      root = createRoot(mountNode);
      const initial = latestScene.current;
      mountedScene.current = initial;
      root.render(React.createElement(mod.Excalidraw, {
        initialData: { elements: initial.elements, files: initial.files,
          appState: { ...drawingDocumentState(initial.appState ?? {}), collaborators: new Map() } } as never,
        excalidrawAPI: (api) => {
          if (cancelled) return;
          apiRef.current = api as unknown as MinimalExcalidrawApi;
          reportReady();
        },
        handleKeyboardGlobally: false,
        autoFocus: false,
        UIOptions: { canvasActions: { saveToActiveFile: false } },
        onChange: (elements, state) => {
          if (cancelled || !ready || state.isLoading) return;
          autosave(elements as unknown[], state as unknown as Record<string, unknown>);
        },
      }));
      const onKeyDown = (event: KeyboardEvent): void => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
        if (!(event.target instanceof Node) || !hostRef.current?.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        autosave.cancel();
        const api = apiRef.current;
        if (!api) return;
        void Promise.resolve(saveRef.current(drawingId, {
          elements: api.getSceneElements(), appState: drawingDocumentState(api.getAppState()), files: api.getFiles?.(),
        })).then(() => toastRef.current.push({ kind: 'success', message: '绘图已保存', ttl: 1500 }))
          .catch((error: unknown) => toastRef.current.push({ kind: 'error',
            message: `保存绘图失败：${error instanceof Error ? error.message : String(error)}`, ttl: 3000 }));
      };
      window.addEventListener('keydown', onKeyDown, true);
      removeKeyDown = () => window.removeEventListener('keydown', onKeyDown, true);
    })().catch((error: unknown) => {
      if (!cancelled) toastRef.current.push({ kind: 'error',
        message: `加载绘图失败：${error instanceof Error ? error.message : String(error)}`, ttl: 3000 });
    });
    return () => {
      cancelled = true;
      clearTimeout(readinessTimer);
      autosave.cancel();
      if (autosaveRef.current === autosave) autosaveRef.current = null;
      removeKeyDown?.();
      apiRef.current = null;
      void window.todoList.drawing.canvasGone(drawingId);
      mountNode?.remove();
      // React forbids unmounting a nested root during its parent's commit.
      const oldRoot = root;
      if (oldRoot) setTimeout(() => oldRoot.unmount(), 0);
    };
  }, [drawingId, sceneLoaded, todoId]);

  return <div className={className} style={{ position: 'relative' }}>
    <button type="button" aria-label="导出绘图 PNG" title="导出整张绘图为 PNG 图片"
      style={{ position: 'absolute', right: 60, bottom: 16, zIndex: 2 }}
      onClick={() => {
        const api = apiRef.current;
        if (!api) return;
        void exportDrawingPng(api).then((image) => {
          const link = document.createElement('a');
          link.href = image.dataUrl;
          link.download = `${drawingId}.png`;
          link.click();
        }).catch((cause: unknown) => toastRef.current.push({ kind: 'error',
          message: `导出失败：${cause instanceof Error ? cause.message : String(cause)}`, ttl: 3000 }));
      }}>导出 PNG</button>
    {error && <div role="alert">绘图加载失败：{error}</div>}
    <div ref={hostRef} style={{ height: '100%' }} aria-label="绘图画布" />
  </div>;
};

async function defaultSave(todoId: string, drawingId: string, scene: { elements?: unknown; appState?: unknown; files?: unknown }): Promise<void> {
  const result = await window.todoList.drawing.save(todoId, scene as never, drawingId);
  if (!result.ok) throw new Error(result.message ?? '绘图保存失败');
}

function debounced<T extends (...args: never[]) => unknown>(fn: T, ms: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callback = (...args: Parameters<T>): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, ms);
  };
  return Object.assign(callback, { cancel: () => { clearTimeout(timer); timer = undefined; } }) as T & { cancel(): void };
}
