// Single source of truth for IPC channels. Imported by main (router), preload (expose), renderer (ipc-client).
// Any channel not declared here is rejected by the router as "unknown_channel".

import type {
  ContentVersionEntry,
  DrawingMeta,
  Group,
  GroupCounts,
  GroupCreate,
  GroupPatch,
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

// ----- group.* -----

export interface GroupListRes {
  groups: Group[];
  counts: GroupCounts;
}
export interface GroupCreateReq { input: GroupCreate }
export interface GroupUpdateReq { id: ULID; patch: GroupPatch }

// ----- ai.* -----

/** Renderer -> main: kick off a streaming AI invocation. */
export interface AIAskReq {
  prompt: string;
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
export interface AIStreamCancelReq { invocationId: string }
export interface AIHealthRes {
  ok: boolean;
  mode: 'real' | 'shim';
  latencyMs?: number;
  error?: string;
}
export interface AIModelsRes { models: AIModel[] }
export interface AIGetMemoryReq {}
export interface AIForgetMemoryReq { id: ULID }

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
}
export interface SettingsGetRes extends AISettings {
  captureHotkey: string;
  theme: 'system' | 'light' | 'dark';
  dataDir: string;
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

  'group.list': IpcChannel<undefined, IpcResult<GroupListRes>>;
  'group.create': IpcChannel<GroupCreateReq, IpcResult<Group>>;
  'group.update': IpcChannel<GroupUpdateReq, IpcResult<Group>>;
  'group.delete': IpcChannel<{ id: ULID }, IpcResult<void>>;

  'ai.invoke': IpcChannel<{ prompt: string; model?: AIModel; tools?: string[] }, IpcResult<{ invocationId: string }>>;
  'ai.cancel': IpcChannel<AIStreamCancelReq, IpcResult<{ ok: boolean }>>;
  'ai.ask': IpcChannel<AIAskReq, IpcResult<AIAskRes>>;
  'ai.health': IpcChannel<undefined, IpcResult<AIHealthRes>>;
  'ai.models': IpcChannel<undefined, IpcResult<AIModelsRes>>;
  'ai.getMemory': IpcChannel<AIGetMemoryReq, IpcResult<AIMemoryEntry[]>>;
  'ai.forgetMemory': IpcChannel<AIForgetMemoryReq, IpcResult<void>>;
  'ai.event': IpcChannel<{ event: AIStreamEvent }, IpcResult<void>>; // push main -> renderer
  'ai.parseCapturePreview': IpcChannel<{ text: string }, IpcResult<ParsedTodo>>;

  'permission.prompt': IpcChannel<PermissionPromptReq, IpcResult<void>>;
  'permission.respond': IpcChannel<{ response: PermissionResponse }, IpcResult<void>>;

  'settings.get': IpcChannel<SettingsGetReq, IpcResult<SettingsGetRes>>;
  'settings.set': IpcChannel<SettingsSetReq, IpcResult<SettingsGetRes>>;
  // Opens a native folder picker; on confirm, persists dataDir and relaunches.
  'settings.chooseDataDir': IpcChannel<undefined, IpcResult<SettingsChooseDataDirRes>>;

  // Capture window submit. Renderer hands us a title + optional body markdown.
  'capture.submit': IpcChannel<{ title: string; markdown?: string }, IpcResult<{ id: ULID }>>;

  // Pop the native application menu at the cursor (title-bar 菜单 button).
  'app.popupMenu': IpcChannel<undefined, IpcResult<void>>;

  // User-menu actions (bottom-left chip): about dialog, check-for-update, quit.
  'app.action': IpcChannel<AppActionReq, IpcResult<void>>;
}

export interface AppActionReq {
  action: 'about' | 'checkUpdate' | 'quit';
}

export type IpcChannelName = keyof IpcRegistry;
export type IpcRequest<C extends IpcChannelName> = IpcRegistry[C]['request'];
export type IpcResponse<C extends IpcChannelName> = IpcRegistry[C]['response'];