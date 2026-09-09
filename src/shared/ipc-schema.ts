// Single source of truth for IPC channels. Imported by main (router), preload (expose), renderer (ipc-client).
// Any channel not declared here is rejected by the router as "unknown_channel".

import type {
  ContentVersionEntry,
  DrawingMeta,
  InboxAttachment,
  SearchHit,
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
export interface TodoBatchUpdateReq { ids: ULID[]; patch: TodoPatch }
export interface TodoSearchReq { query: string; limit?: number }
export interface TodoStatsReq { windowDays?: number }

// ----- content.* -----

export interface ContentReadBodyReq { id: ULID }
export interface ContentReadBodyRes { markdown: string; version: number }
export interface ContentWriteBodyReq { id: ULID; markdown: string; expectVersion?: number }
export interface ContentWriteBodyRes { version: number; updatedAt: number }
export interface ContentHistoryReq { id: ULID }
export interface ContentRestoreVersionReq { id: ULID; versionId: number }

// ----- drawing.* -----

export interface DrawingListReq { todoId: ULID }
export interface DrawingReadReq { id: ULID }
export interface DrawingSaveReq { todoId: ULID; id?: ULID; title?: string; scene: unknown }
export interface DrawingDeleteReq { id: ULID }
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
}
export interface AIAskRes {
  invocationId: string;
  costUsd: number;
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

export interface AIConversationListReq { includeArchived?: boolean }
export interface AIConversationListRes { conversations: AIConversation[] }

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

export interface AIConversationHistoryReq { id: string }
/** Mirrors DshRuntime.HistoryTurn — see src/main/dsh/dsh-runtime.ts. */
export type AIConversationHistoryTurn =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; reasoning?: string }
  | { type: 'tool'; name: string; args?: unknown; ok: boolean; data?: unknown; error?: string };
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
  // Auto-archive: archive done tasks older than N days. 0 = never.
  archiveAfterDays?: number;
}
export interface SettingsGetRes extends AISettings {
  captureHotkey: string;
  theme: 'system' | 'light' | 'dark';
  dataDir: string;
  archiveAfterDays: number;
}
export interface SettingsChooseDataDirRes {
  /** Chosen path, or null if the user cancelled the dialog. */
  path: string | null;
}

// ----- Channel registry -----

export interface IpcRegistry {
  'todo.list': IpcChannel<TodoListReq, IpcResult<Todo[]>>;
  'todo.get': IpcChannel<TodoGetReq, IpcResult<Todo | null>>;
  'todo.create': IpcChannel<TodoCreateReq, IpcResult<{ id: ULID; todo: Todo }>>;
  'todo.update': IpcChannel<TodoUpdateReq, IpcResult<Todo>>;
  'todo.delete': IpcChannel<TodoDeleteReq, IpcResult<void>>;
  'todo.batchUpdate': IpcChannel<TodoBatchUpdateReq, IpcResult<Todo[]>>;
  'todo.search': IpcChannel<TodoSearchReq, IpcResult<SearchHit[]>>;
  'todo.stats': IpcChannel<TodoStatsReq, IpcResult<TodoStats>>;

  'content.readBody': IpcChannel<ContentReadBodyReq, IpcResult<ContentReadBodyRes>>;
  'content.writeBody': IpcChannel<ContentWriteBodyReq, IpcResult<ContentWriteBodyRes>>;
  'content.history': IpcChannel<ContentHistoryReq, IpcResult<ContentVersionEntry[]>>;
  'content.restoreVersion': IpcChannel<ContentRestoreVersionReq, IpcResult<void>>;

  'drawing.list': IpcChannel<DrawingListReq, IpcResult<DrawingMeta[]>>;
  'drawing.read': IpcChannel<DrawingReadReq, IpcResult<unknown>>;
  'drawing.save': IpcChannel<DrawingSaveReq, IpcResult<DrawingMeta>>;
  'drawing.delete': IpcChannel<DrawingDeleteReq, IpcResult<void>>;
  'drawing.setThumb': IpcChannel<DrawingThumbSetReq, IpcResult<void>>;

  'inbox.attach': IpcChannel<InboxAttachReq, IpcResult<InboxAttachment>>;
  'inbox.attachBlob': IpcChannel<InboxAttachBlobReq, IpcResult<InboxAttachment>>;

  'ai.cancel': IpcChannel<AIStreamCancelReq, IpcResult<{ ok: boolean }>>;
  'ai.ask': IpcChannel<AIAskReq, IpcResult<AIAskRes>>;
  'ai.health': IpcChannel<undefined, IpcResult<AIHealthRes>>;
  'ai.models': IpcChannel<undefined, IpcResult<AIModelsRes>>;
  'ai.getMemory': IpcChannel<AIGetMemoryReq, IpcResult<AIMemoryEntry[]>>;
  'ai.forgetMemory': IpcChannel<AIForgetMemoryReq, IpcResult<void>>;
  'ai.event': IpcChannel<{ event: AIStreamEvent }, IpcResult<void>>; // push main -> renderer
  'ai.parseCapturePreview': IpcChannel<{ text: string }, IpcResult<ParsedTodo>>;

  // ----- ai.conversation.* -----
  'ai.conversation.list': IpcChannel<AIConversationListReq, IpcResult<AIConversationListRes>>;
  'ai.conversation.create': IpcChannel<AIConversationCreateReq, IpcResult<AIConversationCreateRes>>;
  'ai.conversation.rename': IpcChannel<AIConversationRenameReq, IpcResult<AIConversationRenameRes>>;
  'ai.conversation.archive': IpcChannel<AIConversationArchiveReq, IpcResult<{ ok: boolean }>>;
  'ai.conversation.unarchive': IpcChannel<AIConversationUnarchiveReq, IpcResult<{ ok: boolean }>>;
  'ai.conversation.delete': IpcChannel<AIConversationDeleteReq, IpcResult<AIConversationDeleteRes>>;
  'ai.conversation.confirmDelete': IpcChannel<AIConversationConfirmDeleteReq, IpcResult<AIConversationConfirmDeleteRes>>;
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

  // Type-only exports of the push-direction payloads so the renderer
  // can read the event bus payload shape without redeclaring it.
  // (The channels themselves are not IPC-registered — events are
  // delivered via the renderer-side `useAppEvent` hook.)

  'settings.get': IpcChannel<SettingsGetReq, IpcResult<SettingsGetRes>>;
  'settings.set': IpcChannel<SettingsSetReq, IpcResult<SettingsGetRes>>;
  // Opens a native folder picker; on confirm, persists dataDir and relaunches.
  'settings.chooseDataDir': IpcChannel<undefined, IpcResult<SettingsChooseDataDirRes>>;

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
}

export interface AppActionReq {
  action: 'about' | 'checkUpdate' | 'quit';
}

export type IpcChannelName = keyof IpcRegistry;
export type IpcRequest<C extends IpcChannelName> = IpcRegistry[C]['request'];
export type IpcResponse<C extends IpcChannelName> = IpcRegistry[C]['response'];