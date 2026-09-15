// Renderer-side typed facade for the contextBridge `window.todoList` API.

import type {
  IpcChannelName,
  IpcRequest,
  IpcResponse,
} from './ipc-schema';
import type {
  AIModel,
  AIProvider,
  AICustomProtocol,
  CustomProviderInput,
  CustomProviderView,
  AIStreamEvent,
  PermissionRequest,
  UserQuestionRequest,
  UserQuestionAnswer,
  UserQuestionItem,
  UserQuestionOption,
  UserQuestionAnswerItem,
  UserApprovalRequest,
  UserApprovalAnswer,
} from './ai-types';
import type { Todo, TodoCreate, TodoPatch, TodoFilter, SearchHit, TodoStats } from './todo-types';
import type { ContentVersionEntry } from './todo-types';
import type { ProgressLogEntry } from './todo-types';
import type { DocumentVersionEntry, TaskDocument } from './todo-types';
import type { DrawingMeta, DrawingScene } from './todo-types';
import type { TagDef } from './todo-types';
import type { TaskAppearance, TaskAppearanceCustomPreset } from './task-appearance';

// --- App events pushed from main ---

export type AppEvent =
  | 'app:todo-created'
  | 'app:navigate'
  | 'app:update-available'
  | 'app:update-downloaded'
  | 'app:toggle-ai'
  | 'app:data-changed'
  | 'app:settings-changed'
  | 'app:plan-guide'
  | 'app:startup'
  // Tag catalog changes (DB-backed since v17). Fired whenever a tag
  // mutation lands (rename / merge / cleanup / reactivate). The
  // payload carries the affected todo id list so the renderer can
  // refresh those rows directly instead of a full re-fetch.
  | 'app:tags-changed'
  | 'ai:stream'
  | 'ai:permission-request'
  // L4-G: human-in-the-loop bridges for DSH user-questions + user-approval.
  // Pushed from the main-process waterfall listener when a tool call
  // awaits a UI decision. The renderer renders the appropriate card
  // inline in the assistant turn and replies via `ai.userQuestion.answer`
  // / `ai.userApproval.answer` IPC channels.
  | 'ai:user-question-request'
  | 'ai:user-question-timeout'
  | 'ai:user-approval-timeout'
  | 'ai:user-approval-request';

/** Coarse-grained scope of a data mutation, so the renderer can re-fetch only
 *  the stores that actually changed (e.g. the AI's todo.create tool mutating
 *  the DB in the main process). */
export type DataScope = 'todos' | 'content' | 'drawings' | 'conversations' | 'tags';

export interface AppEventMap {
  'app:todo-created': { id: string };
  'app:navigate': { route: string };
  'app:update-available': { version: string };
  'app:update-downloaded': { version: string };
  'app:toggle-ai': Record<string, never>;
  'app:data-changed': { scope: DataScope };
  'app:settings-changed': Record<string, never>;
  /** Fired by the main-process reminder scheduler (and by `app.popupMenu`
   *  "今天安排" items if any are added later) to open the in-app plan guide.
   *  Payload currently empty — the renderer recomputes todayStart + candidates
   *  on receipt, so a stale payload can never pin the user to yesterday. */
  'app:plan-guide': Record<string, never>;
  /** Startup state snapshot pushed whenever core / ai changes phase. The
   *  renderer calls `app.startup.get()` once before subscribing to make sure
   *  it doesn't miss a transition that already fired. */
  'app:startup': import('./ipc-schema').StartupSnapshot;
  /** Tag catalog mutation notification. `affectedTodoIds` is the list of
   *  todo ids whose tag set changed (rename / merge / cleanup may touch
   *  many tasks; other operations pass an empty list since they don't
   *  mutate the association table — only the catalog row's retired_at). */
  'app:tags-changed': { affectedTodoIds?: string[] };
  'ai:stream': AIStreamEvent;
  'ai:permission-request': PermissionRequest;
  'ai:user-question-request': UserQuestionRequest;
  'ai:user-question-timeout': { reqId: string };
  'ai:user-approval-timeout': { reqId: string };
  'ai:user-approval-request': UserApprovalRequest;
}

// Renderer-side arg shapes. Match the IPC channel request types but with
// string ids (renderer never sees ULID branded strings as a distinct type).
export interface CaptureSubmitArgs {
  title: string;
  markdown?: string;
}

export interface InboxAttachArgs {
  id: string;
  filePath: string;
  mime: string;
}

export interface InboxAttachBlobArgs {
  todoId: string;
  dataUrl: string;
  filename: string;
  mime: string;
}

export interface InboxListArgs { todoId: string }
export interface InboxReadArgs { id: string }
export interface InboxRemoveArgs { id: string }

export interface SettingsPatchArgs {
  provider?: AIProvider;
  apiKey?: string;
  model?: AIModel;
  streaming?: boolean;
  captureHotkey?: string;
  theme?: 'system' | 'light' | 'dark';
  dataDir?: string;
  customProviders?: CustomProviderInput[];
  customProviderId?: string | null;
  /** User-Agent header for LLM provider requests. Empty = adapter default. */
  userAgent?: string;
  archiveAfterDays?: number;
  tags?: TagDef[];
  /** Daily reminder time for the 「今日待办」 push, format `HH:MM` (24h). */
  dailyPlanReminderTime?: string;
  /** Last day the startup plan-guide was resolved (ISO `YYYY-MM-DD`,
   *  local time). Written by the guide modal after a confirm/skip. */
  lastPlanGuideDate?: string | null;
  /** Epoch-ms until which the guide and scheduled reminder stay muted. */
  snoozePlanGuideUntil?: number | null;
  /** 任务优先级配色。theme 模式不修改 colors；custom 模式传完整 colors。 */
  taskAppearance?: TaskAppearance;
  /** 用户在设置面板里创建的命名自定义配色预设。 */
  taskAppearanceCustomPresets?: TaskAppearanceCustomPreset[];
  /** Auto-updater master switch. Toggling this takes effect
   *  immediately (cancels / schedules the post-startup background
   *  check) and persists across restarts. */
  autoUpdate?: boolean;
  /** AI 助手「对话列表」未归档容量上限。0 = 不限；超过时新建后会
   *  自动物理删除最老的（按 updated_at ASC）。归档里的对话不受此
   *  限制。默认 100。设置 UI 在 Settings → 数据 → AI 对话保留数量。 */
  maxConversations?: number;
}

// --- TodoListApi ---

export interface TodoListApi {
  todo: {
    list(filter: TodoFilter): Promise<IpcResponse<'todo.list'>>;
    get(id: string): Promise<IpcResponse<'todo.get'>>;
    create(input: TodoCreate): Promise<IpcResponse<'todo.create'>>;
    update(id: string, patch: TodoPatch): Promise<IpcResponse<'todo.update'>>;
    delete(id: string): Promise<IpcResponse<'todo.delete'>>;
    restore(id: string): Promise<IpcResponse<'todo.restore'>>;
    batchUpdate(ids: string[], patch: TodoPatch): Promise<IpcResponse<'todo.batchUpdate'>>;
    search(q: string, limit?: number): Promise<IpcResponse<'todo.search'>>;
    stats(windowDays?: number): Promise<IpcResponse<'todo.stats'>>;
    /** Persist the task's currently-selected document tab so it survives
     *  app restart. `tabId` is the renderer's composite id (`d:<docId>` /
     *  `g:<drawingId>`); pass null to clear. Does NOT bump updated_at. */
    setSelectedDoc(todoId: string, tabId: string | null): Promise<IpcResponse<'todo.setSelectedDoc'>>;
  };
  content: {
    readBody(id: string): Promise<IpcResponse<'content.readBody'>>;
    writeBody(
      id: string,
      markdown: string,
      expectVersion?: number,
    ): Promise<IpcResponse<'content.writeBody'>>;
    history(id: string): Promise<IpcResponse<'content.history'>>;
    restoreVersion(id: string, versionId: string): Promise<IpcResponse<'content.restoreVersion'>>;
    /** Git-backed save history (separate from the DB content_versions above,
     *  which is used for AI session restore). `available: false` on the
     *  response means git isn't on PATH — the editor then hides the
     *  History button. */
    gitHistory(id: string): Promise<IpcResponse<'content.gitHistory'>>;
    /** Restore the working-tree markdown file to a given git commit SHA. */
    gitRestore(id: string, sha: string): Promise<IpcResponse<'content.gitRestore'>>;
  };
  progress: {
    /** Record a progress entry: sets the percent + appends an audit-log row
     *  with an optional one-line note. Returns the new entry + refreshed todo. */
    log(todoId: string, percent: number, note?: string): Promise<IpcResponse<'progress.log'>>;
    /** Audit timeline for a task, newest-first. */
    list(todoId: string): Promise<IpcResponse<'progress.list'>>;
    /** Update the note on an existing progress_log entry (click-to-edit the
     *  latest progress description). Returns the updated entry or null. */
    updateNote(entryId: string, note: string | null): Promise<IpcResponse<'progress.updateNote'>>;
  };
  document: {
    /** List a task's documents (progress / note_md / drawing / attachment /
     *  link), ordered by ord. Ensures the default progress doc exists. */
    list(todoId: string): Promise<IpcResponse<'document.list'>>;
    create(req: {
      todoId: string;
      kind: TaskDocument['kind'];
      title?: string | null;
      refId?: string | null;
      url?: string | null;
      description?: string | null;
    }): Promise<IpcResponse<'document.create'>>;
    /** Read the latest versioned content of a progress / note_md doc. */
    read(id: string): Promise<IpcResponse<'document.read'>>;
    write(id: string, content: string, expectVersion?: number): Promise<IpcResponse<'document.write'>>;
    rename(id: string, title: string): Promise<IpcResponse<'document.rename'>>;
    remove(id: string): Promise<IpcResponse<'document.remove'>>;
    history(id: string): Promise<IpcResponse<'document.history'>>;
    restoreVersion(id: string, versionId: number): Promise<IpcResponse<'document.restoreVersion'>>;
    /** Per-document git-backed save history. `available: false` means git
     *  isn't on PATH — the editor hides the History button. */
    gitHistory(id: string): Promise<IpcResponse<'document.gitHistory'>>;
    /** Restore a document's content to a given git commit SHA by writing it
     *  back as a new DB version (so the editor + FTS index stay in sync). */
    gitRestore(id: string, sha: string): Promise<IpcResponse<'document.gitRestore'>>;
  };
  drawing: {
    list(todoId: string): Promise<IpcResponse<'drawing.list'>>;
    read(id: string): Promise<IpcResponse<'drawing.read'>>;
    save(
      todoId: string,
      scene: DrawingScene,
      id?: string,
      title?: string,
    ): Promise<IpcResponse<'drawing.save'>>;
    delete(id: string): Promise<IpcResponse<'drawing.delete'>>;
    rename(id: string, title: string): Promise<IpcResponse<'drawing.rename'>>;
    setThumb(id: string, dataUrl: string): Promise<IpcResponse<'drawing.setThumb'>>;
  };
  link: {
    /** Fetch a URL's page metadata (<title> + meta/og:description) from the
     *  main process (the renderer can't due to CORS). Best-effort: on failure
     *  returns empty strings, never rejects — the caller falls back to blank
     *  editable fields. */
    fetchMeta(url: string): Promise<IpcResponse<'link.fetchMeta'>>;
  };
  inbox: {
    attach(args: InboxAttachArgs): Promise<IpcResponse<'inbox.attach'>>;
    attachBlob(args: InboxAttachBlobArgs): Promise<IpcResponse<'inbox.attachBlob'>>;
    list(args: InboxListArgs): Promise<IpcResponse<'inbox.list'>>;
    read(args: InboxReadArgs): Promise<IpcResponse<'inbox.read'>>;
    remove(args: InboxRemoveArgs): Promise<IpcResponse<'inbox.remove'>>;
  };
  settings: {
    get(): Promise<IpcResponse<'settings.get'>>;
    set(patch: SettingsPatchArgs): Promise<IpcResponse<'settings.set'>>;
    chooseDataDir(): Promise<IpcResponse<'settings.chooseDataDir'>>;
  };
  app: {
    /** Pop the native application menu at the cursor (title-bar 菜单 button). */
    popupMenu(): Promise<IpcResponse<'app.popupMenu'>>;
    /** Pop a single category's submenu (flat topbar buttons). */
    popupMenuCategory(category: '文件' | '编辑' | '视图' | '窗口' | '帮助'): Promise<IpcResponse<'app.popupMenuCategory'>>;
    /**
     * Show a native file picker. On confirm, main reads up to `maxBytes` of
     * the file as utf-8 text and returns `{ canceled:false, text, name, ... }`.
     * Returns `{ canceled:true }` if the user dismisses the dialog. Returns
     * `ok:false` with code `not_text` / `too_large` if the file is binary or
     * over the byte limit, so the renderer can surface a clear message.
     */
    pickFile(opts?: { maxBytes?: number }): Promise<IpcResponse<'app.pickFile'>>;
    /** User-menu actions (bottom-left chip). */
    action(a: 'about' | 'checkUpdate' | 'quit'): Promise<IpcResponse<'app.action'>>;
    /** OS username for the bottom-left chip (no hardcoded preset identity). */
    osUser(): Promise<IpcResponse<'app.osUser'>>;
    /** Renderer → main: tell main what's currently focused so the AI can
     *  ground its answers via `app.currentContext`. Pass `null` to clear. */
    setFocus(focus: AppFocus | null): Promise<IpcResponse<'app.focus.set'>>;
    /** Renderer → main: read the current focus (used for sync after a reload
     *  or for cross-window context). */
    getFocus(): Promise<IpcResponse<'app.focus.get'>>;
    /** Open the task's on-disk documents directory in the OS file manager. */
    openTaskDir(todoId: string): Promise<IpcResponse<'app.openTaskDir'>>;
    /** Dim / restore the frameless titleBarOverlay so the native min/max/close
     *  glyphs blend with a modal backdrop. See ipc-schema.ts. */
    setTitleBarOverlay(opts: { dim: boolean }): Promise<IpcResponse<'app.setTitleBarOverlay'>>;
    /** Snapshot query — current core + ai startup state. Renderer MUST call
     *  this once before subscribing to `app:startup` so it doesn't miss a
     *  ready transition that fired between page-load and listener-ready. */
    startupGet(): Promise<IpcResponse<'app.startup.get'>>;
    /** UX-01 in-session retry. Returns `{ accepted, reason? }` — when
     *  `accepted: false`, the caller should NOT change its UI state
     *  because main rejected the retry (component already in a non-failed
     *  state, or another retry is in flight). State transitions still
     *  arrive via `app:startup` events. */
    startupRetry(component: 'ai'): Promise<IpcResponse<'app.startup.retry'>>;
    /** SEC-01 — enable / disable the JSON-RPC bridge. When enabling,
     *  main auto-generates a capability token (if none exists) and
     *  returns it in `data.token`. The user MUST copy it before
     *  dismissing the dialog — it's the auth material their scripts
     *  present on the first line of each request. Toggling takes effect
     *  on the next app launch; the settings UI surfaces a hint. */
    sdkBridgeSetEnabled(enabled: boolean): Promise<IpcResponse<'app.sdkBridge.setEnabled'>>;
    /** SEC-01 — generate a fresh capability token. Always disables the
     *  bridge (rotation usually means "invalidate outstanding clients");
     *  the user re-enables it via `sdkBridgeSetEnabled(true)`. Returns
     *  the new token exactly once. */
    sdkBridgeRotateToken(): Promise<IpcResponse<'app.sdkBridge.rotateToken'>>;
    /** OBS-01 — build a redacted diagnostics bundle and return both the
     *  structured form (`bundle`) and the JSON-serialized form
     *  (`json`). The renderer is expected to write `json` to a
     *  user-chosen file via `dialog.showSaveDialog`. The bundle is
     *  redacted in main; never logs / writes the unredacted form. */
    diagnosticsExport(): Promise<IpcResponse<'app.diagnostics.export'>>;
    /** OBS-01 — open the OS Save dialog and write `json` to the
     *  chosen path. Returns the absolute path on success, or `null`
     *  if the user cancelled. */
    diagnosticsSaveToFile(defaultName: string, json: string): Promise<IpcResponse<'app.diagnostics.saveToFile'>>;
    /** QUALITY-01 — run deterministic task-health rules. Pure
     *  read; does NOT mutate anything. Returns a sorted list of
     *  issues + the wall-clock time the check ran. */
    healthCheck(): Promise<IpcResponse<'app.health.check'>>;
    /** REL-01 MVP-1 — create a hot-backup snapshot of the SQLite DB
     *  + durable file projections (todos/ + drawings/ + attachments/)
     *  into a unique subfolder under the user-chosen `destDir`. The
     *  DSH session logs are intentionally excluded (regenerable,
     *  large, may contain user prompts). Returns the backup path +
     *  a redacted manifest; the manifest is also written to
     *  `<path>/manifest.json` byte-for-byte so it survives a renderer
     *  reload. Restore + delete are not in MVP-1. */
    backupCreate(destDir: string): Promise<IpcResponse<'app.backup.create'>>;
    /** REL-01 MVP-1 — open the OS folder picker for the backup
     *  destination. Returns `{ canceled: true }` if the user dismisses
     *  the dialog; otherwise `{ canceled: false, path: <abs> }`. */
    backupChooseDest(): Promise<IpcResponse<'app.backup.chooseDest'>>;
    /** STARTUP-AI-ASYNC-002 — renderer → main handshake signalling
     *  that the React App has rendered its first frame. Main uses
     *  this to schedule the heavy DSH warm-up so the splash can
     *  come down on core.ready alone. Idempotent — the first call
     *  schedules `bootAiAndDispatch`, subsequent calls are silent
     *  no-ops. The IPC promise always resolves with `accepted: true`
     *  so the renderer's call site doesn't need to retry. */
    rendererReady(): Promise<IpcResponse<'app.renderer.ready'>>;
    /** Auto-updater (electron-updater → GitCode releases feed).
     *  See src/main/updates/updater.ts. dev mode returns
     *  `devMode: true` so the renderer can disable the button. */
    updaterStatus(): Promise<IpcResponse<'app.updater.status'>>;
    updaterCheck(): Promise<IpcResponse<'app.updater.check'>>;
    updaterInstall(): Promise<IpcResponse<'app.updater.install'>>;
  };
  capture: {
    submit(args: CaptureSubmitArgs): Promise<IpcResponse<'capture.submit'>>;
  };
  ai: {
    health(): Promise<IpcResponse<'ai.health'>>;
    models(): Promise<IpcResponse<'ai.models'>>;
    /** Cancel the in-flight turn on a conversation. The renderer should pass
     *  the same conversationId it used for ai.ask; invocationId is optional
     *  for diagnostics. */
    cancel(conversationId: string, invocationId?: string): Promise<IpcResponse<'ai.cancel'>>;
    /**
     * Submit one user turn on a conversation. conversationId is REQUIRED:
     * the main process maps it 1:1 to a DSH Session (persisted to JSONL by
     * dsh-session-persistence-jsonl). Two ai.ask calls with the same
     * conversationId serialize onto the same agent handle; different
     * conversationIds run on independent agents in parallel.
     *
     * The renderer is expected to call ai.conversation.list() / create() first
     * to discover / allocate the id it wants to write to. passing a fresh
     * ULID-shaped id without a corresponding DB row will fail in main as
     * "unknown conversation".
     */
    ask(req: {
      prompt: string;
      conversationId: string;
      model?: AIModel;
      tools?: string[];
      invocationId?: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
      /** Explicit user intent. `'create-task'` flips main into the
       *  create-task envelope path; absent / `'chat'` keeps the request
       *  as a normal chat turn. See src/shared/task-creation.ts. */
      intent?: 'chat' | 'create-task';
    }): Promise<IpcResponse<'ai.ask'>>;
    /** Rule-based NL capture preview (works offline; returns structured fields). */
    parseCapturePreview(text: string): Promise<IpcResponse<'ai.parseCapturePreview'>>;
    /** Fire-and-forget tag recommendation for the TagInput popover. Advisory
     *  only — failure paths collapse to `{tags: []}` so the popover is never
     *  blocked on the AI. See ai-handlers.ts / src/main/ipc/ai-handlers.ts
     *  for the actual implementation (5s timeout, default limit 4 / max 8,
     *  existingTags steering). */
    suggestTags(req: {
      title: string;
      body?: string;
      existingTags?: string[];
      limit?: number;
    }): Promise<IpcResponse<'ai.suggestTags'>>;
  };
  /**
   * Conversation control. Each conversation is an independent AI thread the
   * user owns — list / create / rename / archive / delete, plus a history
   * endpoint that loads the persisted event log (decoded from JSONL) for
   * the AIPane to render prior turns when switching back to a thread.
   */
  conversation: {
    list(opts?: { includeArchived?: boolean; limit?: number; offset?: number }): Promise<IpcResponse<'ai.conversation.list'>>;
    create(input?: { title?: string }): Promise<IpcResponse<'ai.conversation.create'>>;
    rename(id: string, title: string): Promise<IpcResponse<'ai.conversation.rename'>>;
    archive(id: string): Promise<IpcResponse<'ai.conversation.archive'>>;
    unarchive(id: string): Promise<IpcResponse<'ai.conversation.unarchive'>>;
    delete(id: string): Promise<IpcResponse<'ai.conversation.delete'>>;
    /** L3-F: themed delete confirmation. Returns whether the user confirmed.
     *  Replaces window.confirm() — native dialog respects the OS theme. */
    confirmDelete(id: string, title: string): Promise<IpcResponse<'ai.conversation.confirmDelete'>>;
    /** 批量硬删：删除多行 + 各自的 JSONL 日志。返回实际删除的 DB 行数
     *  （≤ ids.length）。上限 200（main 夹紧）。 */
    deleteMany(ids: string[]): Promise<IpcResponse<'ai.conversation.deleteMany'>>;
    /** 批量删除的主题化 confirm：一次弹窗搞定多行。titles 可选；
     *  传前几个标题进 detail 做示例展示。 */
    confirmDeleteMany(count: number, titles?: string[]): Promise<IpcResponse<'ai.conversation.confirmDeleteMany'>>;
    /** Load decoded history turns from the persistence backend. */
    history(id: string): Promise<IpcResponse<'ai.conversation.history'>>;
  };
  // Tag catalog (DB-backed since v17). list() returns the full catalog
  // (active + retired) with usage counts; activeCatalog() returns just
  // the active rows for the autocomplete popover. rename / merge /
  // previewCleanup / applyCleanup / reactivate are the management UI
  // surface. Every mutation broadcasts `app:tags-changed` with the
  // affected todo ids so the renderer can refresh in place.
  tag: {
    list(opts?: { activeOnly?: boolean }): Promise<IpcResponse<'tag.list'>>;
    activeCatalog(): Promise<IpcResponse<'tag.activeCatalog'>>;
    rename(oldName: string, newName: string): Promise<IpcResponse<'tag.rename'>>;
    recolor(name: string, color: string): Promise<IpcResponse<'tag.recolor'>>;
    merge(sources: string[], target: string, newColor?: string): Promise<IpcResponse<'tag.merge'>>;
    previewCleanup(): Promise<IpcResponse<'tag.previewCleanup'>>;
    applyCleanup(actions: import('./ipc-schema').CleanupActions): Promise<IpcResponse<'tag.applyCleanup'>>;
    reactivate(name: string): Promise<IpcResponse<'tag.reactivate'>>;
  };
  // L4-G: human-in-the-loop answers for DSH user-questions + user-approval
  // waterfalls. The push directions are events (`ai:user-question-request`,
  // `ai:user-approval-request`); the renderer correlates its reply via
  // the `reqId` minted by the main-process listener.
  aiUserQuestion: {
    answer(reqId: string, answers: import('./ai-types').UserQuestionAnswerItem[]): Promise<IpcResponse<'ai.userQuestion.answer'>>;
  };
  aiUserApproval: {
    answer(reqId: string, decision: 'allow-once' | 'reject'): Promise<IpcResponse<'ai.userApproval.answer'>>;
  };
  on<E extends AppEvent>(event: E, cb: (payload: AppEventMap[E]) => void): () => void;
}

/** Renderer-side mirror of the main `AppFocus` interface. Pushes what the
 *  user is currently looking at so the AI can ground its answers in real
 *  context via the `app.currentContext` DSH tool. */
export interface AppFocus {
  kind: 'document' | 'drawing' | 'task';
  todoId: string;
  documentId?: string;
  documentKind?: string;
  documentTitle?: string | null;
  drawingId?: string;
  drawingTitle?: string | null;
  taskTitle?: string | null;
}

// Re-exports for renderer convenience.
export type { Todo, TodoCreate, TodoPatch, TodoFilter, SearchHit, TodoStats };
export type { ContentVersionEntry };
export type { ProgressLogEntry };
export type { DocumentVersionEntry, TaskDocument };
export type { DrawingMeta, DrawingScene };
export type { AIModel, AIProvider, AICustomProtocol, CustomProviderInput, CustomProviderView, AIStreamEvent, PermissionRequest, UserQuestionRequest, UserQuestionAnswer, UserQuestionItem, UserQuestionOption, UserQuestionAnswerItem, UserApprovalRequest, UserApprovalAnswer };
export type { IpcChannelName, IpcRequest, IpcResponse };
