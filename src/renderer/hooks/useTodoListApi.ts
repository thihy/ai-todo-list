// Tiny hooks over window.todoList (the contextBridge API).
//
// Each hook returns either the latest response (useTodo, useStats, useSettings)
// or the latest data + a stable callback for refresh + writes (useProgress,
// useDocuments, useDocument, useDrawing, useDrawings). Hooks use AbortController
// to drop in-flight responses when the consuming component unmounts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TodoListApi, AppEvent, AppEventMap, SettingsPatchArgs } from '../../shared/todo-list-api';
import type { Todo, TodoFilter, SearchHit, TodoStats } from '../../shared/todo-types';
import type { ContentVersionEntry, GitHistoryEntry, ProgressLogEntry } from '../../shared/todo-types';
import type { TaskDocument } from '../../shared/todo-types';
import type { DrawingMeta, DrawingScene, InboxAttachment } from '../../shared/todo-types';
import type { AIModel, AIStreamEvent } from '../../shared/ai-types';
import type { SettingsGetRes, TagCatalogRow, TagCatalogEntry, StartupComponentState } from '../../shared/ipc-schema';
import { useDataVersion } from '../data-bus';
import { compactAiStreamEvents } from '../dsh/stream-buffer';
import { deriveProviderStatus, type ProviderStatus } from '../dsh/provider-status';
import { normalizeTaskAppearance } from '../../shared/task-appearance';
import { useToastBus } from '../components/Toast';

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
  const filterKey = JSON.stringify(filter);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.todoList.todo.list(filterRef.current);
    setData(unwrap(res, [] as Todo[]));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, filterKey, dataVersion]);

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

/** 在设置读取边界统一归一化——只覆盖 taskAppearance 字段，其他字段原样
 *  保留。这样响应里缺 / null / 旧格式的 taskAppearance 都不会让 TaskAppearancePane
 *  在 `value.mode` 上炸掉。SettingsGetRes 的 taskAppearance 类型是必填，但跨
 *  版本主进程（更老的二进制没下发这个字段）仍是现实情况，必须在边界做兜底。 */
function normalizeSettingsResponse(settings: SettingsGetRes): SettingsGetRes {
  return {
    ...settings,
    taskAppearance: normalizeTaskAppearance(settings.taskAppearance),
  };
}

/** Thrown by `useSettings().patch` when the settings store rejects a
 *  write. We strip the patch argument before it can reach the message so a
 *  failure reading `保存 API Key 时磁盘满了` doesn't leak the key into a
 *  toast / log line / devtools console. */
export class SettingsPatchError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'settings_patch_failed') {
    super(message);
    this.name = 'SettingsPatchError';
    this.code = code;
  }
}

export function useSettings(): {
  data: SettingsGetRes | null;
  /** True when the most recent settings read is older than the in-flight
   *  `patch` round-trip — i.e. the user-visible settings may be lagging
   *  the freshly-saved value while we wait for the broadcast. */
  syncing: boolean;
  patch: (patch: SettingsPatchArgs) => Promise<void>;
  chooseDataDir: () => Promise<string | null>;
} {
  const [data, setData] = useState<SettingsGetRes | null>(null);
  const [syncing, setSyncing] = useState(false);
  const refresh = useCallback(async () => {
    const res = await window.todoList.settings.get();
    if (res.ok) setData(normalizeSettingsResponse(res.data));
  }, []);
  const patch = useCallback(
    async (patch: SettingsPatchArgs) => {
      setSyncing(true);
      try {
        const res = await window.todoList.settings.set(patch);
        if (!res.ok) {
          // Surface a human-readable reason but NEVER include the patch
          // payload (it can carry apiKey, customProviders.apiKey, etc.).
          const reason = res.message ?? '保存失败';
          throw new SettingsPatchError(reason);
        }
        setData(normalizeSettingsResponse(res.data));
      } finally {
        setSyncing(false);
      }
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
  // shows stale `monthlyCostUsd` until the user reopens it. We also re-fetch
  // after any other renderer/main patch so concurrent writers stay aligned.
  //
  // The patch write itself updates `data` synchronously inside `patch()`,
  // so this broadcast only matters for CHANGES MADE BY OTHER ACTORS (the AI
  // bumping monthlyCostUsd is the only one in practice). We still replace
  // `data` on the broadcast — consumers that need draft-isolation handle
  // it themselves (TaskAppearancePane keeps its own draft).
  useEffect(() => {
    return window.todoList.on('app:settings-changed', () => { void refresh(); });
  }, [refresh]);
  return { data, syncing, patch, chooseDataDir };
}

/** Run a `useSettings().patch(...)` call with the project's standard
 *  toast feedback. Designed for one-shot settings writes (API key save,
 *  custom-provider save, plan-guide snooze, etc.) where the caller does
 *  not want to manage the saving/saved/failed state machine itself.
 *
 *  Contract:
 *    - Logs and shows an error toast on rejection (never throws — failures
 *      become a visible toast so the user knows their action did NOT save).
 *    - Does NOT modify the patch payload — the underlying hook handles
 *      redaction on the error path; this wrapper just decides UI feedback.
 *
 *  Use this for any one-shot write where a save failure is best surfaced as
 *  a non-blocking toast. For draft-style edits with their own status row,
 *  call `patch` directly and manage the state machine yourself. */
export function useSettingsPatchWithToast(): (patch: SettingsPatchArgs) => Promise<void> {
  const { patch } = useSettings();
  const toast = useToastBus();
  return useCallback(
    async (next: SettingsPatchArgs) => {
      try {
        await patch(next);
      } catch (err) {
        const reason = err instanceof Error && err.message ? err.message : '保存失败';
        toast.push({ kind: 'error', message: `保存失败：${reason}`, ttl: 4000 });
      }
    },
    [patch, toast],
  );
}

/** 把 useSettings 的静态配置派生成本地展示用的 ProviderStatus,
 *  给 Statusbar / AIPane 这种纯展示组件用。
 *
 *  注意:本 hook 不再触发 ai.health 探测。"已配置" ≠ "网络可达",常驻
 *  的"已配置但未连接"标签会让实际可用但 /models 拒绝的自定义服务被误
 *  报成未连接——所有失败信号由当次提问的错误展示承担。 */
export function useProviderStatus(): ProviderStatus {
  const { data: settings } = useSettings();
  return useMemo(() => deriveProviderStatus(settings), [settings]);
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
  // L5-A: wire carries raw DSH `sessionEvent`s. We re-emit the narrower
  // synthesized token / reasoning events that AIPane needs (so it doesn't
  // have to walk the SessionEventMap vocabulary). Tool-call pairing +
  // projection lives in `projectStreamTurn` as a pure function against the
  // raw sessionEvents — it MUST NOT live in this React updater, because
  // StrictMode runs the updater twice and any side-effect map mutation
  // here would be lost / duplicated, breaking call/result pairing.
  const [events, setEvents] = useState<AIStreamEvent[]>([]);
  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  useAppEvent('ai:stream', (e) => {
    setEvents((prev) => {
      const next = [...prev];
      // Stamp arrival time on every event we keep, for turn-metrics
      // (time-to-first-token, duration). One now() per batch — coalesced
      // events keep the FIRST push's ts (the arrival we care about).
      const now = Date.now();
      // Bound only older invocation residue. Every event from the invocation
      // currently arriving is retained, so a long live answer can never lose
      // its prefix. runSubmit still calls clear() before a new local turn.
      const compact = (arr: AIStreamEvent[]): AIStreamEvent[] =>
        compactAiStreamEvents(arr, e.invocationId);

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
          return compact(next);
        }
        // Forward the raw sessionEvent verbatim. Tool-call pairing is
        // reconstructed downstream by projectStreamTurn as a pure function
        // over the events array — see the comment at the top of this hook.
        next.push({ ...e, ts: now });
        return compact(next);
      }
      // start / done / error / permissionRequest: forward verbatim.
      next.push({ ...e, ts: now });
      return compact(next);
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

// ---- Tag catalog (DB-backed since v17) ----
//
// useTagCatalog is the autocomplete-source hook (active rows only,
// no usage counts). It re-fetches whenever the 'tags' scope changes
// via app:tags-changed → emitDataChanged('tags'). TagInput uses this
// instead of the legacy settings.tags array.
//
// useTagList is the management-pane hook (full catalog + usage counts
// + retired visibility). The management pane typically fetches both
// `activeOnly=false` (default list) and `activeOnly=true` (active
// tab) — `useTagList` exposes an opts arg for that.

export function useTagCatalog(): { data: TagCatalogRow[]; loading: boolean; refresh: () => Promise<void> } {
  const [data, setData] = useState<TagCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const dataVersion = useDataVersion(['tags']);
  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.todoList.tag.activeCatalog();
    if (res.ok) setData(res.data ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { data, loading, refresh };
}

export function useTagList(opts?: { activeOnly?: boolean }): {
  data: TagCatalogEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<TagCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const dataVersion = useDataVersion(['tags']);
  const activeOnly = opts?.activeOnly ?? false;
  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.todoList.tag.list({ activeOnly });
    if (res.ok) setData(res.data ?? []);
    setLoading(false);
  }, [activeOnly]);
  useEffect(() => {
    void refresh();
  }, [refresh, dataVersion]);
  return { data, loading, refresh };
}

/** UX-01 — Subscribe to the AI component of the startup state machine.
 *
 *  Returns the latest `StartupComponentState` for `ai` and a stable
 *  `retry()` callback. The state is initialised from a one-shot snapshot
 *  (must happen BEFORE we subscribe to `app:startup`, otherwise a fast
 *  ready/failed transition could be lost), and then kept fresh by the
 *  push event. This mirrors the same pattern main.tsx uses for the splash.
 *
 *  `retry()` is safe to call any time. Main enforces single-flight; if the
 *  retry isn't accepted (component already loading / not failed), the
 *  returned `accepted` will be false and the hook does not mutate state.
 *  UI callers should disable retry buttons while `state.status === 'loading'`
 *  to avoid spamming. */
export interface UseStartupAiState {
  state: StartupComponentState;
  retry: () => Promise<{ accepted: boolean; reason?: 'not_failed' | 'already_in_flight' }>;
}

export function useStartupAiState(): UseStartupAiState {
  const [state, setState] = useState<StartupComponentState>({
    status: 'pending',
    phase: 'boot',
    startedAt: 0,
    statusAt: 0,
  });

  // Snapshot first. See src/renderer/main.tsx for the same "snapshot then
  // subscribe" pattern that prevents missing transitions that fire between
  // page-load and listener-ready.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.todoList.app.startupGet();
      if (cancelled) return;
      if (res.ok) setState(res.data.ai);
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Push subscription. The ref keeps the latest state for callers without
  // making `retry` re-create on every status flip.
  const stateRef = useRef(state);
  stateRef.current = state;

  useAppEvent('app:startup', (snap) => {
    setState(snap.ai);
  });

  const retry = useCallback(async (): Promise<{ accepted: boolean; reason?: 'not_failed' | 'already_in_flight' }> => {
    const res = await window.todoList.app.startupRetry('ai');
    if (!res.ok) {
      // Transport-level error (router rejected the channel, etc.). Surface
      // as a non-accepted retry so the UI doesn't pretend it succeeded.
      return { accepted: false, reason: 'already_in_flight' };
    }
    // The main handler either sets ai.status='loading' on accept, or
    // returns the rejection reason. We don't need to optimistically
    // mutate state here — the `app:startup` event will follow shortly.
    return {
      accepted: res.data?.accepted ?? false,
      reason: res.data?.reason,
    };
  }, []);

  return { state, retry };
}
