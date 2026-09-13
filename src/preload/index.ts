// preload/index.ts — single context bridge.
// Renderer accesses everything via window.todoList.* (see shared/todo-list-api.ts).
// Sandboxed: no direct Node, no ipcRenderer without allowlisting.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isKnownChannel } from '../shared/channels';
import type {
  IpcChannelName,
  IpcRequest,
  IpcResponse,
} from '../shared/ipc-schema';
import type {
  AppEvent,
  AppEventMap,
  TodoListApi,
  CaptureSubmitArgs,
  InboxAttachArgs,
  InboxAttachBlobArgs,
  InboxListArgs,
  InboxReadArgs,
  InboxRemoveArgs,
  SettingsPatchArgs,
} from '../shared/todo-list-api';

// Cached at module load: list of channels whose response is a `void` (none for now).
// Each call passes channel + payload; renderer never sees ipcRenderer directly.

function invoke<C extends IpcChannelName>(
  channel: C,
  req: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  if (!isKnownChannel(channel)) {
    return Promise.resolve({
      ok: false,
      code: 'unknown_channel',
      message: `Unknown channel: ${channel}`,
    } as IpcResponse<C>);
  }
  return ipcRenderer.invoke('__todo_router__', channel, req);
}

// Channel-list listeners: map event name to renderer-side listener.
// Each `app:*` event coming from main is re-emitted on window.todoList.on*.
const APP_EVENTS: AppEvent[] = [
  'app:todo-created',
  'app:navigate',
  'app:update-available',
  'app:update-downloaded',
  'app:toggle-ai',
  'app:data-changed',
  'app:settings-changed',
  'app:plan-guide',
  // Startup state push — fired whenever main's core / ai component changes
  // phase. Renderer reads `startupGet()` first to avoid missing the initial
  // transition (see src/main/startup-state.ts for the contract).
  'app:startup',
  // Tag catalog changes (DB-backed since v17). Renderer hooks that
  // read tag.* state should re-fetch on this event; affectedTodoIds
  // narrows the refresh to the tasks whose tag list actually moved.
  'app:tags-changed',
  'ai:stream',
  'ai:permission-request',
  // L4-G: human-in-the-loop events. The main-process waterfall listener
  // pushes these when a DSH tool calls ask_user_question / a guarded
  // tool needs binary approval. The renderer renders the matching
  // inline card and posts the answer back via aiUserQuestion.answer /
  // aiUserApproval.answer (defined below on the TodoListApi object).
  'ai:user-question-request',
  'ai:user-question-timeout',
  'ai:user-approval-timeout',
  'ai:user-approval-request',
];

function onAppEvent<E extends AppEvent>(
  event: E,
  cb: (payload: AppEventMap[E]) => void,
): () => void {
  const listener = (_e: IpcRendererEvent, payload: AppEventMap[E]) => cb(payload);
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}

const api: TodoListApi = {
  todo: {
    list: (filter) => invoke('todo.list', { filter }),
    get: (id) => invoke('todo.get', { id }),
    create: (input) => invoke('todo.create', { input }),
    update: (id, patch) => invoke('todo.update', { id, patch }),
    delete: (id) => invoke('todo.delete', { id }),
    restore: (id) => invoke('todo.restore', { id }),
    batchUpdate: (ids, patch) => invoke('todo.batchUpdate', { ids, patch }),
    search: (q, limit) => invoke('todo.search', { query: q, limit }),
    stats: (windowDays) => invoke('todo.stats', { windowDays }),
  },
  content: {
    readBody: (id) => invoke('content.readBody', { id }),
    writeBody: (id, markdown, expectVersion) =>
      invoke('content.writeBody', { id, markdown, expectVersion }),
    history: (id) => invoke('content.history', { id }),
    restoreVersion: (id, versionId) =>
      invoke('content.restoreVersion', { id, versionId: Number(versionId) }),
    gitHistory: (id) => invoke('content.gitHistory', { id }),
    gitRestore: (id, sha) => invoke('content.gitRestore', { id, sha }),
  },
  progress: {
    log: (todoId, percent, note) => invoke('progress.log', { todoId, percent, note }),
    list: (todoId) => invoke('progress.list', { todoId }),
    updateNote: (entryId, note) => invoke('progress.updateNote', { entryId, note }),
  },
  document: {
    list: (todoId) => invoke('document.list', { todoId }),
    create: (req) => invoke('document.create', req),
    read: (id) => invoke('document.read', { id }),
    write: (id, content, expectVersion) => invoke('document.write', { id, content, expectVersion }),
    rename: (id, title) => invoke('document.rename', { id, title }),
    remove: (id) => invoke('document.remove', { id }),
    history: (id) => invoke('document.history', { id }),
    restoreVersion: (id, versionId) => invoke('document.restoreVersion', { id, versionId: Number(versionId) }),
  },
  drawing: {
    list: (todoId) => invoke('drawing.list', { todoId }),
    read: (id) => invoke('drawing.read', { id }),
    save: (todoId, scene, id, title) =>
      invoke('drawing.save', { todoId, scene, id, title }),
    delete: (id) => invoke('drawing.delete', { id }),
    rename: (id, title) => invoke('drawing.rename', { id, title }),
    setThumb: (id, dataUrl) => invoke('drawing.setThumb', { id, dataUrl }),
  },
  link: {
    fetchMeta: (url) => invoke('link.fetchMeta', { url }),
  },
  inbox: {
    attach: (args: InboxAttachArgs) => invoke('inbox.attach', args),
    attachBlob: (args: InboxAttachBlobArgs) => invoke('inbox.attachBlob', args),
    list: (args: InboxListArgs) => invoke('inbox.list', args),
    read: (args: InboxReadArgs) => invoke('inbox.read', args),
    remove: (args: InboxRemoveArgs) => invoke('inbox.remove', args),
  },
  settings: {
    get: () => invoke('settings.get', undefined as never),
    set: (patch: SettingsPatchArgs) => invoke('settings.set', patch),
    chooseDataDir: () => invoke('settings.chooseDataDir', undefined as never),
  },
  app: {
    popupMenu: () => invoke('app.popupMenu', undefined as never),
    popupMenuCategory: (category: string) => invoke('app.popupMenuCategory', { category }),
    pickFile: (opts) => invoke('app.pickFile', opts ?? {}),
    action: (action) => invoke('app.action', { action }),
    osUser: () => invoke('app.osUser', undefined as never),
    setFocus: (focus) => invoke('app.focus.set', { focus }),
    getFocus: () => invoke('app.focus.get', undefined as never),
    openTaskDir: (todoId) => invoke('app.openTaskDir', { todoId }),
    setTitleBarOverlay: (opts: { dim: boolean }) => invoke('app.setTitleBarOverlay', opts),
    /** Snapshot query — current core + ai startup state. Renderer MUST call
     *  this once before subscribing to `app:startup` so it doesn't miss a
     *  ready transition that fired between page-load and listener-ready. */
    startupGet: () => invoke('app.startup.get', undefined as never),
    /** UX-01 AI retry. */
    startupRetry: (component: 'ai') => invoke('app.startup.retry', { component }),
    /** SEC-01 — enable / disable the JSON-RPC bridge. The token field
     *  in the response is auto-generated on first enable; the user
     *  must copy it (the settings UI shows it once, with a copy button). */
    sdkBridgeSetEnabled: (enabled: boolean) => invoke('app.sdkBridge.setEnabled', { enabled }),
    /** SEC-01 — generate a fresh capability token. Always disables the
     *  bridge; user re-enables afterwards. */
    sdkBridgeRotateToken: () => invoke('app.sdkBridge.rotateToken', undefined as never),
    /** OBS-01 — produce a redacted diagnostics bundle. The renderer is
     *  responsible for writing the `json` field to a user-chosen path
     *  via `dialog.showSaveDialog`. The bundle is redacted in main —
     *  no key / token / absolute path is exposed. */
    diagnosticsExport: () => invoke('app.diagnostics.export', undefined as never),
    /** OBS-01 — drive the OS Save dialog and write the bundle to the
     *  chosen path. Returns the absolute path on success. */
    diagnosticsSaveToFile: (defaultName: string, json: string) =>
      invoke('app.diagnostics.saveToFile', { defaultName, json }),
    /** QUALITY-01 — run deterministic task-health rules. Returns
     *  the issue list + checkedAt timestamp. The renderer is
     *  expected to call this on boot, after `app:data-changed`,
     *  and when the user opens the 健康 pane. */
    healthCheck: () => invoke('app.health.check', undefined as never),
  },
  capture: {
    submit: (args: CaptureSubmitArgs) => invoke('capture.submit', args),
  },
  ai: {
    // AI uses streaming via app events rather than invoke; main pushes to ai:stream.
    // These methods are reserved for non-streaming admin ops.
    health: () => invoke('ai.health', undefined as never),
    models: () => invoke('ai.models', undefined as never),
    /** Cancel the in-flight turn on a conversation. */
    cancel: (conversationId, invocationId) =>
      invoke('ai.cancel', { conversationId, invocationId }),
    ask: (req) => invoke('ai.ask', req),
    parseCapturePreview: (text) => invoke('ai.parseCapturePreview', { text }),
    suggestTags: (req) => invoke('ai.suggestTags', req),
  },
  conversation: {
    list: (opts) => invoke('ai.conversation.list', opts ?? {}),
    create: (input) => invoke('ai.conversation.create', input ?? {}),
    rename: (id, title) => invoke('ai.conversation.rename', { id, title }),
    archive: (id) => invoke('ai.conversation.archive', { id }),
    unarchive: (id) => invoke('ai.conversation.unarchive', { id }),
    delete: (id) => invoke('ai.conversation.delete', { id }),
    confirmDelete: (id, title) => invoke('ai.conversation.confirmDelete', { id, title }),
    history: (id) => invoke('ai.conversation.history', { id }),
  },
  // L4-G: human-in-the-loop answerer. The pending waterfall promise
  // in dsh-runtime.ts is resolved by whichever renderer window posts
  // first (other windows still receive the request event for
  // multi-window consistency, but the answerer only fires once).
  aiUserQuestion: {
    answer: (reqId, answers) => invoke('ai.userQuestion.answer', { reqId, answers }),
  },
  aiUserApproval: {
    answer: (reqId, decision) => invoke('ai.userApproval.answer', { reqId, decision }),
  },
  // Tag catalog (DB-backed since v17). All mutations broadcast
  // `app:tags-changed`; consumers should re-fetch on receipt.
  tag: {
    list: (opts) => invoke('tag.list', { activeOnly: opts?.activeOnly }),
    activeCatalog: () => invoke('tag.activeCatalog', undefined as never),
    rename: (oldName, newName) => invoke('tag.rename', { oldName, newName }),
    merge: (sources, target, newColor) =>
      invoke('tag.merge', { sources, target, ...(newColor ? { newColor } : {}) }),
    previewCleanup: () => invoke('tag.previewCleanup', undefined as never),
    applyCleanup: (actions) => invoke('tag.applyCleanup', { actions }),
    reactivate: (name) => invoke('tag.reactivate', { name }),
  },
  on: onAppEvent,
};

contextBridge.exposeInMainWorld('todoList', api);

// Allow-listed event channels for the renderer.
contextBridge.exposeInMainWorld('__todo_event_channels__', APP_EVENTS);
