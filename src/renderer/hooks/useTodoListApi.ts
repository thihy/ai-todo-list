// Tiny hooks over window.todoList (the contextBridge API).
//
// Each hook returns either the latest response (useTodo, useStats, useSettings)
// or the latest data + a stable callback for refresh + writes (useProgress,
// useDocuments, useDocument, useDrawing, useDrawings). Hooks use AbortController
// to drop in-flight responses when the consuming component unmounts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodoListApi, AppEvent, AppEventMap, SettingsPatchArgs } from '../../shared/todo-list-api';
import type { Todo, TodoFilter, SearchHit, TodoStats } from '../../shared/todo-types';
import type { ContentVersionEntry, GitHistoryEntry, ProgressLogEntry } from '../../shared/todo-types';
import type { TaskDocument } from '../../shared/todo-types';
import type { DrawingMeta, DrawingScene, InboxAttachment } from '../../shared/todo-types';
import type { AIModel, AIStreamEvent } from '../../shared/ai-types';
import type { SettingsGetRes } from '../../shared/ipc-schema';
import { useDataVersion } from '../data-bus';

declare global {
  interface Window {
    todoList: TodoListApi;
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
    const res = await window.todoList.todo.list(filterRef.current);
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
    window.todoList.todo.get(id).then((res) => {
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
      window.todoList.todo.search(q, limit).then((res) => setHits(unwrap(res, [])));
    }, 200);
    return () => clearTimeout(t);
  }, [q, limit]);
  return { hits };
}

export function useStats(windowDays = 7): { stats: TodoStats | null } {
  const [stats, setStats] = useState<TodoStats | null>(null);
  const dataVersion = useDataVersion(['todos']);
  useEffect(() => {
    window.todoList.todo.stats(windowDays).then((res) => setStats(unwrap(res, null as TodoStats | null)));
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
    window.todoList.content.readBody(id).then((res) => {
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
      const res = await window.todoList.content.writeBody(
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
    window.todoList.content.history(id).then((res) => setVersions(unwrap(res, [])));
  }, [id]);
  return { versions };
}

export function useProgress(todoId: string | null): {
  entries: ProgressLogEntry[];
  log: (percent: number, note?: string) => Promise<ProgressLogEntry | null>;
  updateNote: (entryId: string, note: string | null) => Promise<void>;
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
    window.todoList.progress.list(todoId).then((res) => setEntries(unwrap(res, [])));
  }, [todoId, dataVersion]);

  const log = useCallback(
    async (percent: number, note?: string) => {
      if (!todoId) return null;
      const res = await window.todoList.progress.log(todoId, percent, note);
      if (res.ok) {
        // Optimistic prepend for immediate UI feedback; the data-changed
        // broadcast will also trigger a full re-list via dataVersion.
        setEntries((prev) => [res.data.entry, ...prev]);
        return res.data.entry;
      }
      return null;
    },
    [todoId],
  );

  const updateNote = useCallback(
    async (entryId: string, note: string | null) => {
      const res = await window.todoList.progress.updateNote(entryId, note);
      if (res.ok && res.data) {
        setEntries((prev) =>
          prev.map((e) => (e.id === entryId ? { ...e, note: res.data!.note } : e)),
        );
      }
    },
    [],
  );

  return { entries, log, updateNote };
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
    const res = await window.todoList.drawing.list(todoId);
    setDrawings(unwrap(res, []));
  }, [todoId]);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { drawings, refresh };
}

// ----- Attachments (inbox.*) -----

export function useAttachments(todoId: string | null): {
  attachments: InboxAttachment[];
  refresh: () => Promise<void>;
} {
  const [attachments, setAttachments] = useState<InboxAttachment[]>([]);
  // 'content' scope: inbox.remove broadcasts app:data-changed { scope: 'content' }
  // (attachments are also surfaced as task_documents of kind 'attachment', so
  // they share the content scope with the document workspace).
  const dataVersion = useDataVersion(['content']);
  const refresh = useCallback(async () => {
    if (!todoId) {
      setAttachments([]);
      return;
    }
    const res = await window.todoList.inbox.list({ todoId });
    setAttachments(unwrap(res, []));
  }, [todoId]);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { attachments, refresh };
}

// ----- Multi-document workspace (schema v11) -----

/** Git-backed save history for the task's markdown body. `available: false`
 *  means git isn't on PATH — the History button then hides itself. The
 *  caller can `refresh()` after a save to pull the new commit. */
export function useGitHistory(todoId: string | null): {
  available: boolean;
  entries: GitHistoryEntry[];
  refresh: () => Promise<void>;
  restore: (sha: string) => Promise<boolean>;
} {
  const [available, setAvailable] = useState(false);
  const [entries, setEntries] = useState<GitHistoryEntry[]>([]);
  const refresh = useCallback(async () => {
    if (!todoId) {
      setAvailable(false);
      setEntries([]);
      return;
    }
    const res = await window.todoList.content.gitHistory(todoId);
    if (res.ok) {
      setAvailable(res.data.available);
      setEntries(res.data.entries);
    } else {
      setAvailable(false);
      setEntries([]);
    }
  }, [todoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = useCallback(
    async (sha: string): Promise<boolean> => {
      if (!todoId) return false;
      const res = await window.todoList.content.gitRestore(todoId, sha);
      return res.ok;
    },
    [todoId],
  );

  return { available, entries, refresh, restore };
}

export function useDocuments(todoId: string | null): {
  documents: TaskDocument[];
  refresh: () => Promise<void>;
} {
  const [documents, setDocuments] = useState<TaskDocument[]>([]);
  // 'content' scope: document.write/create/remove broadcast app:data-changed
  // { scope: 'content' } so this list + the open editor re-fetch.
  const dataVersion = useDataVersion(['content']);
  const refresh = useCallback(async () => {
    if (!todoId) {
      setDocuments([]);
      return;
    }
    const res = await window.todoList.document.list(todoId);
    setDocuments(unwrap(res, []));
  }, [todoId]);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { documents, refresh };
}

export function useDocument(docId: string | null): {
  content: string;
  version: number | null;
  save: (next: string, expectVersion?: number) => Promise<void>;
  saving: boolean;
  error: string | null;
} {
  const [content, setContent] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataVersion = useDataVersion(['content']);

  useEffect(() => {
    if (!docId) {
      setContent('');
      setVersion(null);
      return;
    }
    window.todoList.document.read(docId).then((res) => {
      const d = unwrap(res, { content: '', version: 0 });
      setContent(d.content);
      setVersion(d.version);
    });
  }, [docId, dataVersion]);

  const save = useCallback(
    async (next: string, expectVersion?: number) => {
      if (!docId) return;
      setSaving(true);
      setError(null);
      const res = await window.todoList.document.write(
        docId,
        next,
        expectVersion ?? version ?? undefined,
      );
      if (!res.ok) {
        setError(res.message ?? 'save_failed');
      } else {
        setVersion(res.data.version);
      }
      setSaving(false);
    },
    [docId, version],
  );

  return { content, version, save, saving, error };
}

export function useDrawing(id: string | null): { scene: DrawingScene | null } {
  const [scene, setScene] = useState<DrawingScene | null>(null);
  useEffect(() => {
    if (!id) {
      setScene(null);
      return;
    }
    window.todoList.drawing.read(id).then((res) => {
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
    const res = await window.todoList.settings.get();
    if (res.ok) setData(res.data);
  }, []);
  const patch = useCallback(
    async (patch: SettingsPatchArgs) => {
      const res = await window.todoList.settings.set(patch);
      if (res.ok) setData(res.data);
    },
    [],
  );
  const chooseDataDir = useCallback(async () => {
    const res = await window.todoList.settings.chooseDataDir();
    if (res.ok) return res.data.path;
    return null;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // L4-E: re-fetch when the AI turns add cost. Without this the SettingsPane
  // shows stale `monthlyCostUsd` until the user reopens it.
  useEffect(() => {
    return window.todoList.on('app:settings-changed', () => { void refresh(); });
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
    return window.todoList.on(event, (p) => cbRef.current(p));
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
    window.todoList.ai.models().then((res) => {
      if (res.ok) setModels((res.data as { models: AIModel[] }).models);
    });
  }, []);
  return { models };
}
