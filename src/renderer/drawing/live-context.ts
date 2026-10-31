import type { LiveDrawingContext } from '../../shared/drawing-engine';
import type { MinimalExcalidrawApi } from './apply';

/** Snapshot the mounted engine, not the last autosaved file. */
export async function readLiveDrawingContext(api: MinimalExcalidrawApi, drawingId: string): Promise<LiveDrawingContext> {
  const state = api.getAppState();
  if (state.isLoading === true) throw new Error('画布尚未就绪');
  const elements = structuredClone(api.getSceneElements());
  const selected = state.selectedElementIds as Record<string, unknown> | undefined;
  const ids = new Set(elements.map(element => (element as { id?: string }).id));
  const selectedElementIds = Object.entries(selected ?? {}).filter(([id, value]) => value === true && ids.has(id)).map(([id]) => id);
  const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const viewport = { scrollX: number(state.scrollX), scrollY: number(state.scrollY), zoom: number((state.zoom as { value?: number } | undefined)?.value, 1), width: number(state.width), height: number(state.height) };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(elements)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { drawingId, revision, elements, selectedElementIds, viewport };
}
