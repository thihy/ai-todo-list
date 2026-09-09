// usePaneWidths — persisted widths for the resizable 3-pane layout. The list
// (left) and AI (right) panes have user-adjustable widths; the detail pane is
// flex:1 (fills the remainder), so only two widths need persisting. Values
// survive restart via localStorage. Clamps keep the panes usable: a pane too
// narrow to read or so wide it starves its neighbours is rejected.

import { useCallback, useEffect, useState } from 'react';

const LIST_KEY = 'thihy.pane.listW';
const AI_KEY = 'thihy.pane.aiW';

const LIST_DEFAULT = 340;
const AI_DEFAULT = 384;

const LIST_MIN = 240;
const LIST_MAX = 560;
const AI_MIN = 280;
const AI_MAX = 720;

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

export function usePaneWidths(): {
  listWidth: number;
  aiWidth: number;
  setListWidth: (next: number) => void;
  setAiWidth: (next: number) => void;
} {
  const [listWidth, setListState] = useState<number>(() => readNum(LIST_KEY, LIST_DEFAULT, LIST_MIN, LIST_MAX));
  const [aiWidth, setAiState] = useState<number>(() => readNum(AI_KEY, AI_DEFAULT, AI_MIN, AI_MAX));

  useEffect(() => {
    try { localStorage.setItem(LIST_KEY, String(listWidth)); } catch { /* ignore */ }
  }, [listWidth]);
  useEffect(() => {
    try { localStorage.setItem(AI_KEY, String(aiWidth)); } catch { /* ignore */ }
  }, [aiWidth]);

  const setListWidth = useCallback((next: number) => setListState(clamp(next, LIST_MIN, LIST_MAX)), []);
  const setAiWidth = useCallback((next: number) => setAiState(clamp(next, AI_MIN, AI_MAX)), []);

  return { listWidth, aiWidth, setListWidth, setAiWidth };
}
