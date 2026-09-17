// Single source of truth for IPC channels. Imported by main (router), preload (expose), renderer (ipc-client).
// Any channel not declared here is rejected by the router as "unknown_channel".

import type {
  ContentVersionEntry,
  DocumentVersionEntry,
  DrawingMeta,
  GitHistoryEntry,
  InboxAttachment,
  ProgressLogEntry,
  SearchHit,
  TagDef,
  TaskDocument,
  Todo,
  TodoCreate,
  TodoFilter,
  TodoPatch,
  TodoStats,
  ULID,
} from './todo-types';
import type {
  AIModel,
  AIProvider,
  AIMemoryEntry,
  AISettings,
  AIStreamEvent,
  CustomProviderInput,
  ParsedTodo,
  PermissionRequest,
  PermissionResponse,
  UserQuestionAnswer,
  UserApprovalAnswer,
} from './ai-types';

import type { TaskAppearance, TaskAppearanceCustomPreset } from './task-appearance';

// ----- Generic envelope -----

export interface IpcSuccess<T> { ok: true; data: T }
export interface IpcFailure { ok: false; code: string; message: string }
export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface IpcChannel<Req, Res> {
  channel: string;
  request: Req;
  response: Res;
}

// ----- todo.* -----

export interface TodoListReq { filter?: TodoFilter }
export interface TodoGetReq { id: ULID }
export interface TodoCreateReq { input: TodoCreate; captureWindow?: boolean }
export interface TodoUpdateReq { id: ULID; patch: TodoPatch }
export interface TodoDeleteReq { id: ULID }
export interface TodoRestoreReq { id: ULID }
export interface TodoBatchUpdateReq { ids: ULID[]; patch: TodoPatch }
export interface TodoSearchReq { query: string; limit?: number }
export interface TodoStatsReq { windowDays?: number }
export interface TodoSetSelectedDocReq { todoId: ULID; tabId: string | null }

// ----- progress.* -----
//
// User-facing progress system (schema v10). progress.log is the "录入进展"
// path: sets the todos.progress column AND appends a progress_log row with
// the user's optional one-line note, returning the new entry + refreshed
// todo. progress.list returns the audit timeline newest-first.

export interface ProgressLogReq { todoId: ULID; percent: number; note?: string }
export interface ProgressLogRes { entry: ProgressLogEntry; todo: Todo }
export interface ProgressListReq { todoId: ULID }
export interface ProgressUpdateNoteReq { entryId: string; note: string | null }

// ----- document.* -----
//
// Multi-document workspace (schema v11). Each task owns task_documents rows;
// progress / note_md docs carry versioned text content in document_versions.
// document.read/write operate on that versioned content; document.create /
// remove / rename manage list metadata for ALL kinds (incl. drawing /
// attachment / link, whose content lives elsewhere via refId / url).

export interface DocumentListReq { todoId: ULID }
export interface DocumentCreateReq {
  todoId: ULID;
  kind: TaskDocument['kind'];
  title?: string | null;
  refId?: string | null;
  url?: string | null;
  /** Short page description for kind === 'link' (fetched <meta description> /
   *  og:description). Ignored for other kinds. */
  description?: string | null;
}
export interface DocumentReadReq { id: ULID }
export interface DocumentReadRes { content: string; version: number }
export interface DocumentWriteReq { id: ULID; content: string; expectVersion?: number }
export interface DocumentWriteRes { version: number; updatedAt: number }
export interface DocumentRenameReq { id: ULID; title: string }
export interface DocumentRemoveReq { id: ULID }
export interface DocumentHistoryReq { id: ULID }
export interface DocumentRestoreVersionReq { id: ULID; versionId: number }
/** Per-document git-backed save history (mirrors content.gitHistory but
 *  keyed by document id so each progress / note_md doc has its own log).
 *  `available: false` means git isn't on PATH. */
export interface DocumentGitHistoryReq { id: ULID }
export interface DocumentGitHistoryRes {
  available: boolean;
  entries: GitHistoryEntry[];
}
export interface DocumentGitRestoreReq { id: ULID; sha: string }

// ----- link.* -----
//
// Link preview fetch (schema v12). The renderer can't fetch arbitrary URLs
// (CORS), so link.fetchMeta runs in the main process: it GETs the URL, parses
// the first chunk of HTML for <title> + <meta description> / og:description,
// and returns them so the add-link dialog can prefill the title + description.
// Best-effort: failures return empty strings, never an error, so the user can
// still type the fields manually.

export interface LinkFetchMetaReq { url: string }
export interface LinkFetchMetaRes {
  title: string;
  description: string;
  /** Final URL after redirects (useful when the input was a shortlink). */
  resolvedUrl: string;
}

// ----- content.* -----

export interface ContentReadBodyReq { id: ULID }
export interface ContentReadBodyRes { markdown: string; version: number }
export interface ContentWriteBodyReq { id: ULID; markdown: string; expectVersion?: number }
export interface ContentWriteBodyRes { version: number; updatedAt: number }
export interface ContentHistoryReq { id: ULID }
export interface ContentRestoreVersionReq { id: ULID; versionId: number }

/** Git-backed save history (separate from the DB content_versions used for
 *  AI session restore). `available: false` means git isn't on PATH — the
 *  editor's History button then quietly hides itself. */
export interface ContentGitHistoryReq { id: ULID }
export interface ContentGitHistoryRes {
  available: boolean;
  entries: GitHistoryEntry[];
}
export interface ContentGitRestoreReq { id: ULID; sha: string }

// ----- drawing.* -----

export interface DrawingListReq { todoId: ULID }
export interface DrawingReadReq { id: ULID }
export interface DrawingSaveReq { todoId: ULID; id?: ULID; title?: string; scene: unknown }
export interface DrawingDeleteReq { id: ULID }
export interface DrawingRenameReq { id: ULID; title: string }
export interface DrawingThumbSetReq { id: ULID; dataUrl: string }

// ----- inbox.* -----

export interface InboxAttachReq { id: ULID; filePath: string; mime: string }
export interface InboxAttachBlobReq {
  todoId: ULID;
  /** data: URL (e.g. `data:image/png;base64,...`) of the pasted image. */
  dataUrl: string;
  filename: string;
  mime: string;
}

export interface InboxListReq { todoId: ULID }
export interface InboxReadRes { dataUrl: string; mime: string; filename: string }
export interface InboxIdReq { id: ULID }

// ----- ai.* -----

/** Renderer -> main: kick off a streaming AI invocation. */
export interface AIAskReq {
  prompt: string;
  /** Required: the user-controlled conversation this turn belongs to. Main
   *  uses it 1:1 as the DSH SessionId and the key for the per-conversation
   *  agent handle cache. Two ai.ask calls on different conversationIds run in
   *  parallel on independent agents; two on the same id serialize onto the
   *  same handle. Passing an id with no DB row fails as "unknown_conversation". */
  conversationId: string;
  model?: AIModel;
  tools?: string[];
  /** Caller-generated id so the renderer can match streamed token/done events
   *  before the IPC response resolves. Main falls back to generating one if
   *  omitted — but then the renderer can't correlate early stream events. */
  invocationId?: string;
  /** Prior conversation turns (user/assistant) sent so the model has multi-turn
   *  context. `prompt` is the newest user message, appended after these. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Explicit user intent for this turn. `'create-task'` flips main into the
   *  create-task envelope path (see `src/shared/task-creation.ts`); absent or
   *  `'chat'` keeps the request as a normal chat turn. Main validates the
   *  value and rejects anything else with `bad_request`. */
  intent?: 'chat' | 'create-task';
}
export interface AIAskRes {
  invocationId: string;
  costUsd: number;
  /** Output token count for this turn — lets the renderer compute tok/s
   *  metrics from the IPC reply itself (the streaming useEffect that
   *  normally computes metrics bails once streamingTurnId clears, which
   *  races the IPC resolve). */
  tokensOut?: number;
  /** The assistant's final text for this turn. The streaming useEffect
   *  normally seeds a text block from the `done` ai:stream event's content,
   *  but that useEffect bails once streamingTurnId clears — and the IPC
   *  resolve can win that race, leaving the turn with no text block (the
   *  "思考中… 然后没有任何内容" bug in the UI path). Seeding from the IPC
   *  reply is authoritative and race-free. */
  content?: string;
}
/** Cancel the in-flight turn on a conversation. The renderer should pass the
 *  same conversationId it used for ai.ask. */
export interface AIStreamCancelReq { conversationId: string; invocationId?: string }
export interface AIHealthRes {
  ok: boolean;
  mode: 'real' | 'shim';
  latencyMs?: number;
  error?: string;
}
export interface AIModelsRes { models: AIModel[] }
export interface AIGetMemoryReq {}
export interface AIForgetMemoryReq { id: ULID }

// ----- ai.conversation.* -----
//
// User-facing control surface over the `conversations` table (DB v3). Each
// conversation maps 1:1 to a DSH SessionId; the JSONL event log lives in
// <DSH_SESSIONS_ROOT>/<id>/ and is decoded on-demand by ai.conversation.history.

export interface AIConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** L3-J: short preview of the last non-tool turn (user prompt or
   *  assistant answer — whichever came last). Computed lazily by
   *  ai.conversation.list from the JSONL log; absent for sessions
   *  with no turns yet, or when the list call omitted history
   *  computation for cost reasons. */
  lastMessagePreview?: string;
  /** L3-J: total turn count (user + assistant; tools are not counted
   *  toward the conversation "depth"). Same lazy-compute caveat as
   *  lastMessagePreview. */
  messageCount?: number;
}

export interface AIConversationListReq {
  includeArchived?: boolean;
  /** 每页条数；缺省 10，上限 50（main 夹紧）。 */
  limit?: number;
  /** 从第几条开始；缺省 0。配合 limit 做「显示更多」分页。 */
  offset?: number;
}
export interface AIConversationListRes {
  conversations: AIConversation[];
  /** 命中总数（含 offset 之前的所有行），方便 UI 展示「共 N 条」。 */
  total: number;
  /** 当前页之后还剩多少条未加载。`remaining > 0` ⇒ 还有可加载的页。 */
  remaining: number;
}

export interface AIConversationCreateReq { title?: string }
export interface AIConversationCreateRes { conversation: AIConversation }

export interface AIConversationRenameReq { id: string; title: string }
export interface AIConversationRenameRes { conversation: AIConversation }

export interface AIConversationArchiveReq { id: string }
export interface AIConversationUnarchiveReq { id: string }
export interface AIConversationDeleteReq { id: string }

export interface AIConversationDeleteRes { /** True if the row existed and was deleted. */ deleted: boolean }

/** L3-F: native themed confirmation before deleting a conversation.
 *  Returns { confirmed } from dialog.showMessageBox so the AIPane can
 *  branch without a blocking window.confirm() (which renders unthemed
 *  on Win11 and breaks the visual flow). */
export interface AIConversationConfirmDeleteReq { id: string; title: string }
export interface AIConversationConfirmDeleteRes { confirmed: boolean }

/** 批量硬删除多行 + JSONL 清理。ids 长度上限 200（main 端夹紧）。 */
export interface AIConversationDeleteManyReq { ids: string[] }
export interface AIConversationDeleteManyRes {
  /** 实际删除的 DB 行数（≤ ids.length，因为有 id 可能不存在）。 */
  deleted: number;
}

/** 批量删除的主题化 confirm —— 复用 L3-F 的 dialog.showMessageBox 模式，
 *  把"删除 N 条"做成一个原生警告弹窗而非连续 N 次。titles 可选，前 3 个
 *  会拼到 detail 里作为示例（"删除选中的 5 条对话？（含："foo"、"bar"…"）"。
 *  UI 在 Settings → 数据 → AI 对话保留 旁边。 */
export interface AIConversationConfirmDeleteManyReq { count: number; titles?: string[] }
export interface AIConversationConfirmDeleteManyRes { confirmed: boolean }

export interface AIConversationHistoryReq { id: string }
/** Mirrors DshRuntime.HistoryTurn — see src/main/dsh/dsh-runtime.ts.
 *  The `intent` field on user turns is preserved through foldHistory so the
 *  renderer can render the create-task operation card for older turns too
 *  (not just the live one). Absent on non-create-task turns.
 *  Tool turns carry a stable `callId` (synthesised `orphan-N` when no
 *  matching call/result was on the wire) and an explicit `state` so the
 *  renderer can distinguish "args = {}" from "未记录输入" and "missing-
 *  result" from a real failure. */
export type AIConversationHistoryTurn =
  | { type: 'user'; text: string; intent?: 'chat' | 'create-task' }
  | { type: 'assistant'; text: string; reasoning?: string }
  | {
      type: 'tool';
      callId: string;
      name: string;
      args?: unknown;
      ok: boolean;
      data?: unknown;
      presentationMeta?: unknown;
      error?: string;
      state: 'done' | 'error' | 'stopped' | 'missing-call' | 'missing-result';
      argsKnown: boolean;
    };
export interface AIConversationHistoryRes { turns: AIConversationHistoryTurn[] }

// ----- permission.* -----

export interface PermissionPromptReq {
  request: PermissionRequest;
  /** Renderer responds with PermissionResponse */
  decision: PermissionResponse;
}

// ----- settings.* -----

export interface SettingsGetReq {}
export interface SettingsSetReq {
  provider?: AIProvider;
  model?: AIModel;
  streaming?: boolean;
  captureHotkey?: string;
  theme?: 'system' | 'light' | 'dark';
  apiKey?: string; // write-only; reading returns redacted form
  dataDir?: string; // absolute path to data directory; relocates on next launch
  // Replace the whole custom-providers list (apiKey-preserved merge server-side).
  customProviders?: CustomProviderInput[];
  // Select which custom instance is active when provider==='custom'.
  customProviderId?: string | null;
  // User-Agent header sent on LLM provider requests. Empty = adapter default
  // (deepseek-harness/…). See llm-adapter.ts — override is via a custom
  // `fetch`, not profile headers (the adapter strips/reserves `user-agent`).
  userAgent?: string;
  // Auto-archive: archive done tasks older than N days. 0 = never.
  archiveAfterDays?: number;
  // Tag registry (name + colour). DEPRECATED: the v17 migration hoists
  // this directory into the DB (tag_catalog). Settings-store accepts
  // the field silently for forward-compat callers but no longer reads
  // or writes it. UI flows through tag.* channels.
  tags?: TagDef[];
  // Daily reminder time for the 「今日待办」 guide / OS notification, format HH:MM.
  dailyPlanReminderTime?: string;
  // Last day the startup guide was resolved (shown + confirmed/skipped).
  // ISO `YYYY-MM-DD` in local time. Renderer writes this after a guide session.
  lastPlanGuideDate?: string | null;
  // Snooze deadline (epoch ms) set by 「改天再提醒」. Until this passes, no
  // boot guide or scheduled reminder fires. Renderer clears it on next launch.
  snoozePlanGuideUntil?: number | null;
  // 任务优先级配色 —— mode=theme 时跟随 CSS 主题；mode=custom 时 colors
  // 完整覆盖 4 个优先级的背景/前景。具体值由 Settings UI 编辑 / 选预设。
  taskAppearance?: TaskAppearance;
  // 用户在设置面板里创建的命名自定义配色预设；空数组表示没有用户预设。
  // 持久化在 userData/config.json，损坏值由 SettingsStore.load() 归一化为 []。
  taskAppearanceCustomPresets?: TaskAppearanceCustomPreset[];
  // AUTO-UPDATE toggle — when false the 5 s post-startup background
  // check is skipped; the manual "检查更新" button is unaffected.
  // Defaults to true (existing installs keep their behaviour).
  autoUpdate?: boolean;
  // AI 助手「对话列表」容量上限：未归档对话超过此数时，ai.conversation.create
  // 会自动物理删除最老的。0 = 不限。默认 100。
  maxConversations?: number;
}
export interface SettingsGetRes extends AISettings {
  captureHotkey: string;
  theme: 'system' | 'light' | 'dark';
  dataDir: string;
  archiveAfterDays: number;
  // Tag registry — DEPRECATED. The v17 migration hoisted the
  // directory into the DB (tag_catalog). This field is kept on
  // the response for backward-compat callers (still empty since
  // the settings store no longer carries it) but the renderer
  // must read tags via tag.activeCatalog instead.
  tags: TagDef[];
  dailyPlanReminderTime: string;
  lastPlanGuideDate: string | null;
  snoozePlanGuideUntil: number | null;
  taskAppearance: TaskAppearance;
  // 用户在设置面板里创建的命名自定义配色预设；空数组表示没有。
  taskAppearanceCustomPresets: TaskAppearanceCustomPreset[];
  /** SEC-01 — current bridge state. `enabled` reflects persistence;
   *  `token` is the live capability token (returned once on rotation
   *  / enable so the user can copy it). When `enabled: false`, `token`
   *  is still returned if one exists, so the user can re-enable without
   *  losing it. `socketPath` is computed by main and surfaces the actual
   *  bind address for clients to connect to. */
  sdkBridge: {
    enabled: boolean;
    token: string | null;
    socketPath: string;
  };
  /** Auto-updater master switch. See PersistedSettings#autoUpdate. */
  autoUpdate: boolean;
  /** AI 助手「对话列表」容量上限。0 = 不限。默认 100。
   *  See PersistedSettings#maxConversations. */
  maxConversations: number;
}
export interface SettingsChooseDataDirRes {
  /** Chosen path, or null if the user cancelled the dialog. */
  path: string | null;
}

// ----- tag catalog (DB-backed since v17) -----
//
// name is the primary key of tag_catalog; retired_at null = active.
// activeCount counts tasks with deleted_at IS NULL AND archived_at IS
// NULL that carry the name; historicalCount counts everything else
// (deleted or archived). The DB layer guarantees COUNT(DISTINCT) so a
// duplicate tag association can't double-count.

export interface TagCatalogRow {
  name: string;
  color: string;
  /** Epoch ms; null = active. */
  retiredAt: number | null;
}

export interface TagCatalogEntry extends TagCatalogRow {
  /** Number of valid (non-deleted, non-archived) tasks carrying this name. */
  activeCount: number;
  /** Number of historical (deleted OR archived) tasks carrying this name. */
  historicalCount: number;
}

export interface CleanupPreviewUnused {
  name: string;
  /** Historical task count for context — the UI uses this to remind
   *  the user that retirement only affects the management list, not
   *  those rows. */
  historicalCount: number;
}

export interface CleanupPreviewSimilar {
  name: string;
  activeCount: number;
}

export interface CleanupPreviewSimilarGroup {
  key: string;
  /** Suggested merge target (most-used member). The UI must let the
   *  user override before apply. */
  target: string;
  members: CleanupPreviewSimilar[];
}

export interface CleanupPreview {
  unused: CleanupPreviewUnused[];
  similar: CleanupPreviewSimilarGroup[];
}

export interface CleanupActions {
  /** Names to mark retired_at (and only those — historical task
   *  associations stay intact). */
  retire?: string[];
  /** Source → target merges to apply. Each entry's sources land on
   *  valid-task associations of `target`; INSERT OR IGNORE de-dupes
   *  a task that already has the target tag. */
  merges?: { sources: string[]; target: string }[];
}

export interface CleanupSkippedEntry {
  name: string;
  reason: string;
}

export interface CleanupApplyResult {
  affectedTodoIds: string[];
  skipped: CleanupSkippedEntry[];
}

// ----- Channel registry -----

export interface IpcRegistry {
  'todo.list': IpcChannel<TodoListReq, IpcResult<Todo[]>>;
  'todo.get': IpcChannel<TodoGetReq, IpcResult<Todo | null>>;
  'todo.create': IpcChannel<TodoCreateReq, IpcResult<{ id: ULID; todo: Todo }>>;
  'todo.update': IpcChannel<TodoUpdateReq, IpcResult<Todo>>;
  'todo.delete': IpcChannel<TodoDeleteReq, IpcResult<void>>;
  'todo.restore': IpcChannel<TodoRestoreReq, IpcResult<void>>;
  'todo.batchUpdate': IpcChannel<TodoBatchUpdateReq, IpcResult<Todo[]>>;
  'todo.search': IpcChannel<TodoSearchReq, IpcResult<SearchHit[]>>;
  'todo.stats': IpcChannel<TodoStatsReq, IpcResult<TodoStats>>;
  'todo.setSelectedDoc': IpcChannel<TodoSetSelectedDocReq, IpcResult<void>>;

  'progress.log': IpcChannel<ProgressLogReq, IpcResult<ProgressLogRes>>;
  'progress.list': IpcChannel<ProgressListReq, IpcResult<ProgressLogEntry[]>>;
  'progress.updateNote': IpcChannel<ProgressUpdateNoteReq, IpcResult<ProgressLogEntry | null>>;

  'document.list': IpcChannel<DocumentListReq, IpcResult<TaskDocument[]>>;
  'document.create': IpcChannel<DocumentCreateReq, IpcResult<TaskDocument>>;
  'document.read': IpcChannel<DocumentReadReq, IpcResult<DocumentReadRes>>;
  'document.write': IpcChannel<DocumentWriteReq, IpcResult<DocumentWriteRes>>;
  'document.rename': IpcChannel<DocumentRenameReq, IpcResult<TaskDocument>>;
  'document.remove': IpcChannel<DocumentRemoveReq, IpcResult<void>>;
  'document.history': IpcChannel<DocumentHistoryReq, IpcResult<DocumentVersionEntry[]>>;
  'document.restoreVersion': IpcChannel<DocumentRestoreVersionReq, IpcResult<void>>;
  'document.gitHistory': IpcChannel<DocumentGitHistoryReq, IpcResult<DocumentGitHistoryRes>>;
  'document.gitRestore': IpcChannel<DocumentGitRestoreReq, IpcResult<void>>;

  'link.fetchMeta': IpcChannel<LinkFetchMetaReq, IpcResult<LinkFetchMetaRes>>;

  'content.readBody': IpcChannel<ContentReadBodyReq, IpcResult<ContentReadBodyRes>>;
  'content.writeBody': IpcChannel<ContentWriteBodyReq, IpcResult<ContentWriteBodyRes>>;
  'content.history': IpcChannel<ContentHistoryReq, IpcResult<ContentVersionEntry[]>>;
  'content.restoreVersion': IpcChannel<ContentRestoreVersionReq, IpcResult<void>>;
  'content.gitHistory': IpcChannel<ContentGitHistoryReq, IpcResult<ContentGitHistoryRes>>;
  'content.gitRestore': IpcChannel<ContentGitRestoreReq, IpcResult<void>>;

  'drawing.list': IpcChannel<DrawingListReq, IpcResult<DrawingMeta[]>>;
  'drawing.read': IpcChannel<DrawingReadReq, IpcResult<unknown>>;
  'drawing.save': IpcChannel<DrawingSaveReq, IpcResult<DrawingMeta>>;
  'drawing.delete': IpcChannel<DrawingDeleteReq, IpcResult<void>>;
  'drawing.rename': IpcChannel<DrawingRenameReq, IpcResult<DrawingMeta>>;
  'drawing.setThumb': IpcChannel<DrawingThumbSetReq, IpcResult<void>>;

  'inbox.attach': IpcChannel<InboxAttachReq, IpcResult<InboxAttachment>>;
  'inbox.attachBlob': IpcChannel<InboxAttachBlobReq, IpcResult<InboxAttachment>>;
  'inbox.list': IpcChannel<InboxListReq, IpcResult<InboxAttachment[]>>;
  'inbox.read': IpcChannel<InboxIdReq, IpcResult<InboxReadRes>>;
  'inbox.remove': IpcChannel<InboxIdReq, IpcResult<null>>;

  'ai.cancel': IpcChannel<AIStreamCancelReq, IpcResult<{ ok: boolean }>>;
  'ai.ask': IpcChannel<AIAskReq, IpcResult<AIAskRes>>;
  'ai.health': IpcChannel<undefined, IpcResult<AIHealthRes>>;
  'ai.models': IpcChannel<undefined, IpcResult<AIModelsRes>>;
  'ai.getMemory': IpcChannel<AIGetMemoryReq, IpcResult<AIMemoryEntry[]>>;
  'ai.forgetMemory': IpcChannel<AIForgetMemoryReq, IpcResult<void>>;
  'ai.event': IpcChannel<{ event: AIStreamEvent }, IpcResult<void>>; // push main -> renderer
  'ai.parseCapturePreview': IpcChannel<{ text: string }, IpcResult<ParsedTodo>>;
  // One-shot non-streaming tag recommendation for the tag-input popover.
  // Returns 0..limit tags (default 4) inferred from the task title (+ optional
  // body markdown). Caller passes `existingTags` so the prompt can steer away
  // from names already in use. Failure modes all collapse to `{tags: []}` —
  // this channel is advisory and must NEVER reject the popover render.
  'ai.suggestTags': IpcChannel<
    {
      title: string;
      body?: string;
      existingTags?: string[];
      limit?: number;
    },
    IpcResult<{ tags: string[] }>
  >;

  // ----- ai.conversation.* -----
  'ai.conversation.list': IpcChannel<AIConversationListReq, IpcResult<AIConversationListRes>>;
  'ai.conversation.create': IpcChannel<AIConversationCreateReq, IpcResult<AIConversationCreateRes>>;
  'ai.conversation.rename': IpcChannel<AIConversationRenameReq, IpcResult<AIConversationRenameRes>>;
  'ai.conversation.archive': IpcChannel<AIConversationArchiveReq, IpcResult<{ ok: boolean }>>;
  'ai.conversation.unarchive': IpcChannel<AIConversationUnarchiveReq, IpcResult<{ ok: boolean }>>;
  'ai.conversation.delete': IpcChannel<AIConversationDeleteReq, IpcResult<AIConversationDeleteRes>>;
  'ai.conversation.confirmDelete': IpcChannel<AIConversationConfirmDeleteReq, IpcResult<AIConversationConfirmDeleteRes>>;
  'ai.conversation.deleteMany': IpcChannel<AIConversationDeleteManyReq, IpcResult<AIConversationDeleteManyRes>>;
  'ai.conversation.confirmDeleteMany': IpcChannel<AIConversationConfirmDeleteManyReq, IpcResult<AIConversationConfirmDeleteManyRes>>;
  'ai.conversation.history': IpcChannel<AIConversationHistoryReq, IpcResult<AIConversationHistoryRes>>;

  'permission.prompt': IpcChannel<PermissionPromptReq, IpcResult<void>>;
  'permission.respond': IpcChannel<{ response: PermissionResponse }, IpcResult<void>>;

  // L4-G: human-in-the-loop answer channels (DSH user-questions +
  // user-approval waterfalls). Push directions (main → renderer) live
  // on the events bus (`ai:user-question-request`, `ai:user-approval-request`)
  // — see AppEventMap. These two are the pull directions: renderer
  // hands the user's structured answer back, the runtime listener
  // resolves the pending waterfall promise on receipt.
  'ai.userQuestion.answer': IpcChannel<UserQuestionAnswer, IpcResult<{ ok: true }>>;
  'ai.userApproval.answer': IpcChannel<UserApprovalAnswer, IpcResult<{ ok: true }>>;
  // OPENSPEC §ai-assistant Persistent and session tool grants. Grant
  // handlers internally resolve the pending waterfall to 'allowed-once'
  // AND persist the grant (always → settings; session → runtime Map),
  // so the renderer doesn't need a separate ai.userApproval.answer leg.
  'ai.userApproval.grantAlways': IpcChannel<
    { reqId: string; toolName: string },
    IpcResult<{ ok: true; reqId: string; persisted: true; settled: boolean }>
  >;
  'ai.userApproval.grantSession': IpcChannel<
    { reqId: string; toolName: string; conversationId: string },
    IpcResult<{ ok: true; reqId: string; persisted: false; settled: boolean }>
  >;
  'ai.tools.listGranted': IpcChannel<
    { conversationId?: string },
    IpcResult<{ always: string[]; session: string[] }>
  >;
  'ai.tools.revoke': IpcChannel<
    { toolName: string; scope: 'always' | 'session'; conversationId?: string },
    IpcResult<{ ok: true; revoked: boolean; scope: 'always' | 'session' }>
  >;

  // Type-only exports of the push-direction payloads so the renderer
  // can read the event bus payload shape without redeclaring it.
  // (The channels themselves are not IPC-registered — events are
  // delivered via the renderer-side `useAppEvent` hook.)

  'settings.get': IpcChannel<SettingsGetReq, IpcResult<SettingsGetRes>>;
  'settings.set': IpcChannel<SettingsSetReq, IpcResult<SettingsGetRes>>;
  // Opens a native folder picker; on confirm, persists dataDir and relaunches.
  'settings.chooseDataDir': IpcChannel<undefined, IpcResult<SettingsChooseDataDirRes>>;

  // Tag catalog management. The v17 migration (src/main/db/schema.ts)
  // hoisted the tag directory into the DB; these channels are the
  // user-facing surface for rename / merge / cleanup. Counts in `list`
  // are computed via JOIN against the todos table + COUNT(DISTINCT) so
  // the renderer doesn't paginate the whole todo list to answer one
  // management question.
  'tag.list': IpcChannel<
    { activeOnly?: boolean },
    IpcResult<TagCatalogEntry[]>
  >;
  'tag.activeCatalog': IpcChannel<
    undefined,
    IpcResult<TagCatalogRow[]>
  >;
  'tag.rename': IpcChannel<
    { oldName: string; newName: string },
    IpcResult<void>
  >;
  'tag.recolor': IpcChannel<
    { name: string; color: string },
    IpcResult<void>
  >;
  'tag.merge': IpcChannel<
    { sources: string[]; target: string; newColor?: string },
    IpcResult<{ affectedTodoIds: string[] }>
  >;
  'tag.previewCleanup': IpcChannel<
    undefined,
    IpcResult<CleanupPreview>
  >;
  'tag.applyCleanup': IpcChannel<
    { actions: CleanupActions },
    IpcResult<CleanupApplyResult>
  >;
  'tag.reactivate': IpcChannel<
    { name: string },
    IpcResult<void>
  >;

  // Capture window submit. Renderer hands us a title + optional body markdown.
  'capture.submit': IpcChannel<{ title: string; markdown?: string }, IpcResult<{ id: ULID }>>;

  // Pop the native application menu at the cursor (title-bar 菜单 button).
  'app.popupMenu': IpcChannel<undefined, IpcResult<void>>;
  // Pop a single category's submenu (flat topbar buttons). `category` is one
  // of 文件/编辑/视图/窗口/帮助.
  'app.popupMenuCategory': IpcChannel<{ category: string }, IpcResult<void>>;

  // Native file picker. The renderer asks the main process to show
  // dialog.showOpenDialog; on confirm, main reads up to `maxBytes` of the
  // file as utf-8 text and returns both the raw text and the metadata.
  // Binary / oversized files return ok=false with code `not_text` /
  // `too_large` so the renderer can surface a clear message instead of
  // silently truncating. Returns ok=true with canceled=true when the user
  // dismisses the dialog.
  'app.pickFile': IpcChannel<
    { maxBytes?: number },
    IpcResult<{
      canceled: boolean;
      path?: string;
      name?: string;
      mime?: string;
      size?: number;
      text?: string;
    }>
  >;

  // User-menu actions (bottom-left chip): about dialog, check-for-update, quit.
  'app.action': IpcChannel<AppActionReq, IpcResult<void>>;

  // The OS username for the bottom-left user chip (so we don't hardcode a
  // preset identity). Returns the login name from os.userInfo().
  'app.osUser': IpcChannel<undefined, IpcResult<{ username: string | null }>>;

  // Renderer → main: the renderer pushes its "current focus" (what the user
  // is looking at right now — a task / document / drawing). The AI's
  // `app.currentContext` tool reads it so its answers are grounded in what
  // the user has open. Pass `null` to clear (e.g. leaving a task).
  'app.focus.set': IpcChannel<{ focus: AppFocus | null }, IpcResult<void>>;
  'app.focus.get': IpcChannel<undefined, IpcResult<AppFocus | null>>;

  // Open the task's on-disk document directory in the OS file manager.
  // Shows the folder containing the task's body markdown + versions + any
  // task-scoped attachments. No-op (with `not_found`) if the task has no
  // directory on disk yet.
  'app.openTaskDir': IpcChannel<{ todoId: string }, IpcResult<{ path: string }>>;
  // Renderer → main: dim / restore the frameless titleBarOverlay so the
  // native min/max/close glyphs match a modal's dimmed client area. The
  // overlay is rendered by Chromium OUTSIDE the renderer's webContents, so
  // renderer-side CSS can't reach it — main must call setTitleBarOverlay()
  // when any modal opens / closes. Idempotent; safe to call repeatedly with
  // the same `dim` value.
  'app.setTitleBarOverlay': IpcChannel<{ dim: boolean }, IpcResult<void>>;

  /** STARTUP-AI-ASYNC-002 — renderer signals that the React App has
   *  completed its first paint. Main uses this as the trigger to start
   *  the heavy DSH warm-up; previously the boot body kicked off
   *  immediately after `markCoreReady()`, which kept the splash
   *  visible for the entire 22 s cold-boot window and could starve
   *  Electron's main-process event loop on Windows.
   *
   *  The signal carries no payload — a no-arg ack is enough. The
   *  handler is idempotent: the first call schedules `bootAiAndDispatch`,
   *  subsequent calls are silent no-ops. */
  'app.renderer.ready': IpcChannel<undefined, IpcResult<{ accepted: boolean }>>;

  // Snapshot query — returns the current startup state. Renderer calls this
  // once on boot BEFORE wiring the `app:startup` event listener to avoid
  // missing the transition that fires between page-load and listener-ready.
  // See src/main/startup-state.ts for the source of truth.
  'app.startup.get': IpcChannel<undefined, IpcResult<StartupSnapshot>>;

  // Auto-updater (electron-updater). `status` is a sync read of the
  // latest known feed state (currentVersion + latestVersion +
  // downloaded); `check` triggers a user-initiated feed check and
  // returns the updated status; `install` calls quitAndInstall on
  // the next tick (the OS dialog / app-restart handoff is
  // platform-specific inside electron-updater).
  'app.updater.status': IpcChannel<undefined, IpcResult<UpdaterStatusRes>>;
  'app.updater.check': IpcChannel<undefined, IpcResult<UpdaterStatusRes>>;
  'app.updater.install': IpcChannel<undefined, IpcResult<void>>;
  /** UX-01 AI retry. Returns `{ accepted: boolean, reason?: 'not_failed' | 'already_in_flight' }`.
   *  Main guarantees single-flight: concurrent retries return `accepted: false`
   *  with `reason: 'already_in_flight'`. State transitions are pushed via
   *  `app:startup`; callers should subscribe and stop polling on receipt. */
  'app.startup.retry': IpcChannel<
    { component: 'ai' },
    IpcResult<{ accepted: boolean; reason?: 'not_failed' | 'already_in_flight' }>
  >;
  /** SEC-01 — toggle the JSON-RPC bridge. Returns the (possibly newly
   *  generated) capability token so the settings UI can display it
   *  once for the user to copy. Toggling requires a restart for the
   *  actual socket to start/stop — the handler records the intent;
   *  `src/main/index.ts` reads it on next boot. */
  'app.sdkBridge.setEnabled': IpcChannel<
    { enabled: boolean },
    IpcResult<{ enabled: boolean; token: string | null }>
  >;
  /** SEC-01 — generate a fresh capability token. Always disables the
   *  bridge (rotation is usually paired with invalidating outstanding
   *  clients); the user re-enables to bring the bridge back up. */
  'app.sdkBridge.rotateToken': IpcChannel<undefined, IpcResult<{ token: string }>>;
  /** OBS-01 — export a redacted diagnostics bundle. The bundle is
   *  already stripped of api keys / tokens / absolute paths / emails
   *  before it leaves main; the renderer is expected to write it to
   *  a user-chosen path via `dialog.showSaveDialog`. `bundle` is the
   *  structured form for in-app display; `json` is the serialized
   *  form for the file. */
  'app.diagnostics.export': IpcChannel<
    undefined,
    IpcResult<{
      bundle: DiagnosticsBundle;
      json: string;
    }>
  >;
  /** OBS-01 — drive the OS Save dialog from main and write the bundle
   *  JSON to the chosen path. Returns the chosen path or null on
   *  cancel. The renderer is expected to call `app.diagnostics.export`
   *  first to obtain `json`, then pass it here. */
  'app.diagnostics.saveToFile': IpcChannel<
    { defaultName: string; json: string },
    IpcResult<{ path: string | null }>
  >;
  /** QUALITY-01 — run deterministic task-health rules and return
   *  the issue list. Pure read; does NOT mutate anything. The
   *  renderer is expected to call this after data changes
   *  (subscribe to `app:data-changed` and re-query). */
  'app.health.check': IpcChannel<
    undefined,
    IpcResult<{
      issues: HealthIssue[];
      checkedAt: number;
    }>
  >;
  /** REL-01 MVP-1 — create a hot-backup snapshot of the SQLite DB +
   *  the durable file projections (todos/ + drawings/ + attachments/).
   *  `destDir` is an absolute path to a directory the user picked via
   *  a native folder picker; main writes the snapshot into a uniquely
   *  named subfolder under it. DSH session logs are intentionally
   *  excluded (regenerable + large + contain user prompts). Returns
   *  the backup path and a redacted manifest. Restore + delete are
   *  not in MVP-1 — the manifest is forward-compatible with both. */
  'app.backup.create': IpcChannel<
    { destDir: string },
    IpcResult<BackupCreateRes>
  >;
  /** REL-01 MVP-1 — native folder picker for the backup destination.
   *  Returns the absolute path on confirm, or `{ canceled: true }` on
   *  dismiss. Separate from `settings.chooseDataDir` (which migrates
   *  the live data dir + restarts) so the backup flow stays
   *  side-effect-free. */
  'app.backup.chooseDest': IpcChannel<
    undefined,
    IpcResult<{ canceled: boolean; path?: string }>
  >;
}

export interface BackupCreateRes {
  /** Absolute path to the backup directory (a freshly-created subfolder
   *  under the user's chosen `destDir`). */
  path: string;
  /** Redacted manifest describing what was captured. Mirrors the on-disk
   *  `manifest.json` byte-for-byte so the renderer can show a summary
   *  without re-reading the file. */
  manifest: BackupManifest;
}

export interface BackupManifest {
  /** Schema version of the source database. Restore refuses to apply
   *  a manifest whose schemaVersion is greater than the running app's
   *  SCHEMA_VERSION (forward-incompat guard). */
  schemaVersion: number;
  /** ISO timestamp at which the backup finished writing. */
  generatedAt: string;
  /** App version that wrote the backup. Informational. */
  appVersion: string;
  /** Basename of the source data directory only — the full absolute path
   *  is intentionally NOT included to avoid leaking the user's directory
   *  layout when a manifest is shared. */
  sourceDataDirName: string;
  counts: {
    todos: number;
    conversations: number;
    tags: number;
    inboxAttachments: number;
  };
  /** Which top-level subdirectories were copied. Each entry is the
   *  basename only (e.g. 'todos'), never an absolute path. */
  sections: {
    todos: boolean;
    drawings: boolean;
    attachments: boolean;
    dshSessions: false;
  };
  /** Total bytes written per section. Sum = total backup size. */
  sizes: {
    db: number;
    todos: number;
    drawings: number;
    attachments: number;
    total: number;
  };
}

export interface StartupSnapshot {
  core: StartupComponentState;
  ai: StartupComponentState;
  /** 自进程启动到当前的总耗时 ms,渲染端展示「启动时间较长…」用。 */
  elapsedMs: number;
}

export type StartupPhase =
  | 'boot'
  | 'settings'
  | 'data-dir'
  | 'db-open'
  | 'file-stores'
  | 'ipc'
  | 'window'
  | 'core-ready'
  | 'ai-loading'
  | 'ai-ready'
  | 'ai-failed';

export type StartupStatus = 'pending' | 'loading' | 'ready' | 'failed';

/** OBS-01 — redacted snapshot of the app + DB state for attaching to
 *  a bug report. The mirror lives here so the renderer can import it
 *  without reaching into `src/main/` (which the web tsconfig doesn't
 *  include). Main builds an object that satisfies this interface. */
export interface DiagnosticsBundle {
  generatedAt: string;
  appVersion: string;
  system: {
    platform: string;
    arch: string;
    release: string;
    electron: string;
    node: string;
    chrome: string;
  };
  schemaVersion: number;
  startup: StartupSnapshot;
  aiProvider: {
    name: string;
    customName: string | null;
    model: string;
    lastHeartbeatAt: number | null;
    monthlyCostUsd: number;
  };
  taskCounts: {
    total: number;
    byStatus: Partial<Record<string, number>>;
  };
  dataSizes: {
    dbBytes: number | null;
    todosBytes: number | null;
    drawingsBytes: number | null;
    attachmentsBytes: number | null;
    dshSessionsBytes: number | null;
  };
  sdkBridgeEnabled: boolean;
  recentLogs: string[];
}

/** QUALITY-01 — deterministic health issue kinds. Mirror of
 *  src/main/health/rules.ts → HealthIssue; the web tsconfig doesn't
 *  include src/main/ so we duplicate the union here. The two stay
 *  in sync via the `kind` literal — adding a kind requires a
 *  change in both files (and is intentionally not type-pinned
 *  because the rules module is the canonical source). */
export type HealthIssueKind =
  | 'long_doing_no_progress'
  | 'overdue'
  | 'blocked_no_reason'
  | 'parent_done_child_open'
  | 'progress_status_conflict'
  | 'today_overload';

export type HealthSeverity = 'info' | 'warn' | 'blocker';

export interface HealthIssue {
  kind: HealthIssueKind;
  severity: HealthSeverity;
  todoIds: string[];
  message: string;
  data?: Record<string, number | string>;
}

export interface StartupComponentState {
  status: StartupStatus;
  phase: StartupPhase;
  /** 阶段开始时间(epoch ms,主进程内部时钟)。 */
  startedAt: number;
  /** 进入当前 status 的时间,用于计算阶段耗时。 */
  statusAt: number;
  /** 人话错误,绝不包含原始堆栈 / 密钥 / 绝对路径。 */
  errorMessage?: string;
}

export interface UpdaterStatusRes {
  /** Current installed app version (`app.getVersion()`). */
  currentVersion: string;
  /** Latest version advertised by the feed, or null if not yet checked. */
  latestVersion: string | null;
  /** True once a newer version has been fully downloaded. */
  downloaded: boolean;
  /** True while an in-flight check is running. */
  checking: boolean;
  /** True when running in dev mode (`!app.isPackaged`) — auto-updater is a no-op. */
  devMode: boolean;
}

export interface AppFocus {
  kind: 'document' | 'drawing' | 'task';
  todoId: string;
  /** Set when kind === 'document'. */
  documentId?: string;
  documentKind?: string;
  documentTitle?: string | null;
  /** Set when kind === 'drawing'. */
  drawingId?: string;
  drawingTitle?: string | null;
  /** Set when kind === 'task' (no specific doc/drawing selected). */
  taskTitle?: string | null;
}

export interface AppActionReq {
  action: 'about' | 'checkUpdate' | 'quit';
}

export type IpcChannelName = keyof IpcRegistry;
export type IpcRequest<C extends IpcChannelName> = IpcRegistry[C]['request'];
export type IpcResponse<C extends IpcChannelName> = IpcRegistry[C]['response'];
