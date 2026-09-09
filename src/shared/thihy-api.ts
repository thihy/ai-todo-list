// Renderer-side typed facade for the contextBridge `window.thihy` API.

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

// --- App events pushed from main ---

export type AppEvent =
  | 'app:todo-created'
  | 'app:navigate'
  | 'app:update-available'
  | 'app:update-downloaded'
  | 'app:toggle-ai'
  | 'app:data-changed'
  | 'app:settings-changed'
  | 'ai:stream'
  | 'ai:permission-request'
  // L4-G: human-in-the-loop bridges for DSH user-questions + user-approval.
  // Pushed from the main-process waterfall listener when a tool call
  // awaits a UI decision. The renderer renders the appropriate card
  // inline in the assistant turn and replies via `ai.userQuestion.answer`
  // / `ai.userApproval.answer` IPC channels.
  | 'ai:user-question-request'
  | 'ai:user-approval-request';

/** Coarse-grained scope of a data mutation, so the renderer can re-fetch only
 *  the stores that actually changed (e.g. the AI's todo.create tool mutating
 *  the DB in the main process). */
export type DataScope = 'todos' | 'content' | 'drawings' | 'conversations';

export interface AppEventMap {
  'app:todo-created': { id: string };
  'app:navigate': { route: string };
  'app:update-available': { version: string };
  'app:update-downloaded': { version: string };
  'app:toggle-ai': Record<string, never>;
  'app:data-changed': { scope: DataScope };
  'app:settings-changed': Record<string, never>;
  'ai:stream': AIStreamEvent;
  'ai:permission-request': PermissionRequest;
  'ai:user-question-request': UserQuestionRequest;
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
  archiveAfterDays?: number;
}

// --- ThihyApi ---

export interface ThihyApi {
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
  };
  progress: {
    /** Record a progress entry: sets the percent + appends an audit-log row
     *  with an optional one-line note. Returns the new entry + refreshed todo. */
    log(todoId: string, percent: number, note?: string): Promise<IpcResponse<'progress.log'>>;
    /** Audit timeline for a task, newest-first. */
    list(todoId: string): Promise<IpcResponse<'progress.list'>>;
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
    }): Promise<IpcResponse<'document.create'>>;
    /** Read the latest versioned content of a progress / note_md doc. */
    read(id: string): Promise<IpcResponse<'document.read'>>;
    write(id: string, content: string, expectVersion?: number): Promise<IpcResponse<'document.write'>>;
    rename(id: string, title: string): Promise<IpcResponse<'document.rename'>>;
    remove(id: string): Promise<IpcResponse<'document.remove'>>;
    history(id: string): Promise<IpcResponse<'document.history'>>;
    restoreVersion(id: string, versionId: number): Promise<IpcResponse<'document.restoreVersion'>>;
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
    setThumb(id: string, dataUrl: string): Promise<IpcResponse<'drawing.setThumb'>>;
  };
  inbox: {
    attach(args: InboxAttachArgs): Promise<IpcResponse<'inbox.attach'>>;
    attachBlob(args: InboxAttachBlobArgs): Promise<IpcResponse<'inbox.attachBlob'>>;
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
    }): Promise<IpcResponse<'ai.ask'>>;
    /** Rule-based NL capture preview (works offline; returns structured fields). */
    parseCapturePreview(text: string): Promise<IpcResponse<'ai.parseCapturePreview'>>;
  };
  /**
   * Conversation control. Each conversation is an independent AI thread the
   * user owns — list / create / rename / archive / delete, plus a history
   * endpoint that loads the persisted event log (decoded from JSONL) for
   * the AIPane to render prior turns when switching back to a thread.
   */
  conversation: {
    list(opts?: { includeArchived?: boolean }): Promise<IpcResponse<'ai.conversation.list'>>;
    create(input?: { title?: string }): Promise<IpcResponse<'ai.conversation.create'>>;
    rename(id: string, title: string): Promise<IpcResponse<'ai.conversation.rename'>>;
    archive(id: string): Promise<IpcResponse<'ai.conversation.archive'>>;
    unarchive(id: string): Promise<IpcResponse<'ai.conversation.unarchive'>>;
    delete(id: string): Promise<IpcResponse<'ai.conversation.delete'>>;
    /** L3-F: themed delete confirmation. Returns whether the user confirmed.
     *  Replaces window.confirm() — native dialog respects the OS theme. */
    confirmDelete(id: string, title: string): Promise<IpcResponse<'ai.conversation.confirmDelete'>>;
    /** Load decoded history turns from the persistence backend. */
    history(id: string): Promise<IpcResponse<'ai.conversation.history'>>;
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

// Re-exports for renderer convenience.
export type { Todo, TodoCreate, TodoPatch, TodoFilter, SearchHit, TodoStats };
export type { ContentVersionEntry };
export type { ProgressLogEntry };
export type { DocumentVersionEntry, TaskDocument };
export type { DrawingMeta, DrawingScene };
export type { AIModel, AIProvider, AICustomProtocol, CustomProviderInput, CustomProviderView, AIStreamEvent, PermissionRequest, UserQuestionRequest, UserQuestionAnswer, UserQuestionItem, UserQuestionOption, UserQuestionAnswerItem, UserApprovalRequest, UserApprovalAnswer };
export type { IpcChannelName, IpcRequest, IpcResponse };