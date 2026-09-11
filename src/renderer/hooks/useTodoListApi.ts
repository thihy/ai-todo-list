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
import { recoverToolResultValue, parseToolArgs } from '../tool-presentation';

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
  // L5-A: wire carries raw DSH `sessionEvent`s. We re-emit the synthesized
  // token / reasoning / toolCall / done / error events that AIPane consumes.
  // The merge map (callId → {name, args}) lives here, on the renderer, so
  // main doesn't need to track call/result pairing — pure passthrough there.
  const [events, setEvents] = useState<AIStreamEvent[]>([]);
  // useRef so the map survives across renders without triggering rerender.
  // Mutable, never put in state.
  const liveCallMeta = useRef<Map<string, { name: string; args: string }>>(new Map());
  const clear = useCallback(() => {
    setEvents([]);
    liveCallMeta.current.clear();
  }, []);

  useAppEvent('ai:stream', (e) => {
    setEvents((prev) => {
      const next = [...prev];
      // Stamp arrival time on every event we keep, for turn-metrics
      // (time-to-first-token, duration). One now() per batch — coalesced
      // events keep the FIRST push's ts (the arrival we care about).
      const now = Date.now();
      // Cap history to last 200 events to keep memory bounded.
      const cap = (arr: AIStreamEvent[]): AIStreamEvent[] =>
        arr.length > 200 ? arr.slice(arr.length - 200) : arr;

      if (e.type === 'sessionEvent') {
        const raw = e.event;
        const t = raw?.type;
        if (t === 'assistant/chunk') {
          // L5-B: COALESCE adjacent text/reasoning deltas into the last
          // same-kind event instead of pushing one event per delta. A long
          // reasoning turn emits hundreds of `reasoning-delta` chunks; if
          // each became its own event, the array would blow past the 200
          // cap below and `slice(-200)` would drop the EARLIEST deltas —
          // and because the streaming-turn rebuild walks this array to
          // reconstruct reasoning text, the prefix would silently vanish
          // ("思考文本超过一定长度后前面被删"). Coalescing keeps one
          // growing event per run, so the full text survives the cap.
          // We do NOT forward the raw `assistant/chunk` sessionEvent:
          // AIPane only reads the synthesized token/reasoning variants,
          // and keeping the raw chunk would double the event count and
          // re-trigger the cap. Non-chunk sessionEvents below ARE forwarded.
          const d = raw.data as { chunk?: { type?: string; text?: string } } | undefined;
          const chunk = d?.chunk;
          if (chunk?.type === 'text-delta' && chunk.text) {
            const last = next[next.length - 1];
            if (last && last.type === 'token' && last.invocationId === e.invocationId) {
              next[next.length - 1] = { ...last, token: last.token + chunk.text };
            } else {
              next.push({ type: 'token', invocationId: e.invocationId, token: chunk.text, ts: now });
            }
          } else if (chunk?.type === 'reasoning-delta' && chunk.text) {
            const last = next[next.length - 1];
            if (last && last.type === 'reasoning' && last.invocationId === e.invocationId) {
              next[next.length - 1] = { ...last, text: last.text + chunk.text };
            } else {
              next.push({ type: 'reasoning', invocationId: e.invocationId, text: chunk.text, ts: now });
            }
          }
          return cap(next);
        }
        // Forward the raw event verbatim so any consumer that wants the
        // full SessionEvent vocabulary (e.g. a future DSH ToolRow drop-in)
        // can read it directly. AIPane itself only reads the synthesized
        // variants below.
        next.push({ ...e, ts: now });
        if (t === 'tool/call') {
          const d = raw.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
          if (d?.callId != null && d.name) {
            liveCallMeta.current.set(String(d.callId), { name: d.name, args: d.arguments ?? '' });
          }
        } else if (t === 'tool/result') {
          const d = raw.data as {
            message?: {
              source?: { callId?: unknown };
              content?: Array<{ isError?: boolean; content?: unknown[] }>;
            };
          } | undefined;
          const callId = d?.message?.source?.callId;
          const meta = callId != null ? liveCallMeta.current.get(String(callId)) : undefined;
          const block = d?.message?.content?.[0];
          const ok = !block?.isError;
          // L5-A: recover the RAW tool value from the rendered ContentBlock[]
          // the wire carries (jsonOutput.render produced
          // [{type:'text', text: JSON.stringify(value)}]). Feeding the block
          // array directly made presentToolResult render a
          // <pre>[{"type":"text","text":"..."}]</pre> dump. Parse the args
          // JSON string too, so per-tool presentResult handlers see an object.
          next.push({
            type: 'toolCall',
            invocationId: e.invocationId,
            toolName: meta?.name ?? '',
            args: parseToolArgs(meta?.args),
            result: recoverToolResultValue(block?.content),
            ok,
            ts: now,
          });
          if (callId != null) liveCallMeta.current.delete(String(callId));
        }
        return cap(next);
      }
      // start / done / error / permissionRequest: forward verbatim.
      next.push({ ...e, ts: now });
      return cap(next);
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
