// Tiny hooks over window.thihy (the contextBridge API).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThihyApi, AppEvent, AppEventMap, SettingsPatchArgs } from '../../shared/thihy-api';
import type { Todo, TodoFilter, SearchHit, TodoStats } from '../../shared/todo-types';
import type { ContentVersionEntry, ProgressLogEntry } from '../../shared/todo-types';
import type { DrawingMeta, DrawingScene } from '../../shared/todo-types';
import type { AIModel, AIStreamEvent } from '../../shared/ai-types';
import type { SettingsGetRes } from '../../shared/ipc-schema';
import { useDataVersion } from '../data-bus';

declare global {
  interface Window {
    thihy: ThihyApi;
  }
}

function unwrap<T>(res: { ok: boolean; data?: T; message?: string }, fallback: T): T {
  if (!res.ok) throw new Error(res.message ?? 'IPC failed');
  return (res.data as T) ?? fallback;
}

export function useTodos(filter: TodoFilter): {
  data: Todo[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // Re-fetch when the AI (or any background process) mutates todos — otherwise
  // the left list stays stale after the AI creates/updates/deletes a task.
  const dataVersion = useDataVersion(['todos']);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.thihy.todo.list(filterRef.current);
    setData(unwrap(res, [] as Todo[]));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, JSON.stringify(filter), dataVersion]);

  return { data, loading, refresh };
}

export function useTodo(id: string | null): { todo: Todo | null; loading: boolean } {
  const [todo, setTodo] = useState<Todo | null>(null);
  const [loading, setLoading] = useState(false);
  const dataVersion = useDataVersion(['todos']);
  useEffect(() => {
    if (!id) {
      setTodo(null);
      return;
    }
    setLoading(true);
    window.thihy.todo.get(id).then((res) => {
      setTodo(unwrap(res, null as Todo | null));
      setLoading(false);
    });
  }, [id, dataVersion]);
  return { todo, loading };
}

export function useSearch(q: string, limit = 50): { hits: SearchHit[] } {
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!q) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      window.thihy.todo.search(q, limit).then((res) => setHits(unwrap(res, [])));
    }, 200);
    return () => clearTimeout(t);
  }, [q, limit]);
  return { hits };
}

export function useStats(windowDays = 7): { stats: TodoStats | null } {
  const [stats, setStats] = useState<TodoStats | null>(null);
  const dataVersion = useDataVersion(['todos']);
  useEffect(() => {
    window.thihy.todo.stats(windowDays).then((res) => setStats(unwrap(res, null as TodoStats | null)));
  }, [windowDays, dataVersion]);
  return { stats };
}

export function useBody(id: string | null): {
  body: string;
  version: number | null;
  save: (markdown: string, expectVersion?: number) => Promise<void>;
  saving: boolean;
  error: string | null;
} {
  const [body, setBody] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-read when the AI writes the body (content.writeBody) so the editor
  // reflects the model's edit live.
  const dataVersion = useDataVersion(['content']);

  useEffect(() => {
    if (!id) {
      setBody('');
      setVersion(null);
      return;
    }
    window.thihy.content.readBody(id).then((res) => {
      const d = unwrap(res, { markdown: '', version: 0 });
      setBody(d.markdown);
      setVersion(d.version);
    });
  }, [id, dataVersion]);

  const save = useCallback(
    async (markdown: string, expectVersion?: number) => {
      if (!id) return;
      setSaving(true);
      setError(null);
      const res = await window.thihy.content.writeBody(
        id,
        markdown,
        expectVersion ?? version ?? undefined,
      );
      if (!res.ok) {
        setError(res.message ?? 'save_failed');
      } else {
        setVersion(res.data.version);
      }
      setSaving(false);
    },
    [id, version],
  );

  return { body, version, save, saving, error };
}

export function useHistory(id: string | null): { versions: ContentVersionEntry[] } {
  const [versions, setVersions] = useState<ContentVersionEntry[]>([]);
  useEffect(() => {
    if (!id) return;
    window.thihy.content.history(id).then((res) => setVersions(unwrap(res, [])));
  }, [id]);
  return { versions };
}

export function useProgress(todoId: string | null): {
  entries: ProgressLogEntry[];
  log: (percent: number, note?: string) => Promise<void>;
} {
  const [entries, setEntries] = useState<ProgressLogEntry[]>([]);
  // progress.log broadcasts app:data-changed { scope: 'todos' }, which bumps
  // the todos data version. Re-list on that bump so the timeline stays in
  // sync even if the optimistic insert (in `log`) races the broadcast.
  const dataVersion = useDataVersion(['todos']);

  useEffect(() => {
    if (!todoId) {
      setEntries([]);
      return;
    }
    window.thihy.progress.list(todoId).then((res) => setEntries(unwrap(res, [])));
  }, [todoId, dataVersion]);

  const log = useCallback(
    async (percent: number, note?: string) => {
      if (!todoId) return;
      const res = await window.thihy.progress.log(todoId, percent, note);
      if (res.ok) {
        // Optimistic prepend for immediate UI feedback; the data-changed
        // broadcast will also trigger a full re-list via dataVersion.
        setEntries((prev) => [res.data.entry, ...prev]);
      }
    },
    [todoId],
  );

  return { entries, log };
}

export function useDrawings(todoId: string | null): {
  drawings: DrawingMeta[];
  refresh: () => Promise<void>;
} {
  const [drawings, setDrawings] = useState<DrawingMeta[]>([]);
  const dataVersion = useDataVersion(['drawings']);
  const refresh = useCallback(async () => {
    if (!todoId) {
      setDrawings([]);
      return;
    }
    const res = await window.thihy.drawing.list(todoId);
    setDrawings(unwrap(res, []));
  }, [todoId]);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { drawings, refresh };
}

export function useDrawing(id: string | null): { scene: DrawingScene | null } {
  const [scene, setScene] = useState<DrawingScene | null>(null);
  useEffect(() => {
    if (!id) {
      setScene(null);
      return;
    }
    window.thihy.drawing.read(id).then((res) => {
      const scene = unwrap(res, null) as DrawingScene | null;
      setScene(scene ?? null);
    });
  }, [id]);
  return { scene };
}

export function useSettings(): {
  data: SettingsGetRes | null;
  patch: (patch: SettingsPatchArgs) => Promise<void>;
  chooseDataDir: () => Promise<string | null>;
} {
  const [data, setData] = useState<SettingsGetRes | null>(null);
  const refresh = useCallback(async () => {
    const res = await window.thihy.settings.get();
    if (res.ok) setData(res.data);
  }, []);
  const patch = useCallback(
    async (patch: SettingsPatchArgs) => {
      const res = await window.thihy.settings.set(patch);
      if (res.ok) setData(res.data);
    },
    [],
  );
  const chooseDataDir = useCallback(async () => {
    const res = await window.thihy.settings.chooseDataDir();
    if (res.ok) return res.data.path;
    return null;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // L4-E: re-fetch when the AI turns add cost. Without this the SettingsPane
  // shows stale `monthlyCostUsd` until the user reopens it.
  useEffect(() => {
    return window.thihy.on('app:settings-changed', () => { void refresh(); });
  }, [refresh]);
  return { data, patch, chooseDataDir };
}

export function useAppEvent<E extends AppEvent>(
  event: E,
  cb: (payload: AppEventMap[E]) => void,
): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    return window.thihy.on(event, (p) => cbRef.current(p));
  }, [event]);
}

export function useAiStream(): { events: AIStreamEvent[]; clear: () => void } {
  const [events, setEvents] = useState<AIStreamEvent[]>([]);
  const clear = useCallback(() => setEvents([]), []);
  useAppEvent('ai:stream', (e) => {
    setEvents((prev) => {
      const next = [...prev, e];
      // Cap history to last 200 events to keep memory bounded.
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  });
  return { events, clear };
}

export function useModels(): { models: AIModel[] } {
  const [models, setModels] = useState<AIModel[]>([]);
  useEffect(() => {
    window.thihy.ai.models().then((res) => {
      if (res.ok) setModels((res.data as { models: AIModel[] }).models);
    });
  }, []);
  return { models };
}
