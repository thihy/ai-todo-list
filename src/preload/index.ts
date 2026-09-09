// preload/index.ts — single context bridge.
// Renderer accesses everything via window.thihy.* (see shared/thihy-api.ts).
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
  ThihyApi,
  CaptureSubmitArgs,
  InboxAttachArgs,
  InboxAttachBlobArgs,
  SettingsPatchArgs,
} from '../shared/thihy-api';

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
  return ipcRenderer.invoke('__thihy_router__', channel, req);
}

// Channel-list listeners: map event name to renderer-side listener.
// Each `app:*` event coming from main is re-emitted on window.thihy.on*.
const APP_EVENTS: AppEvent[] = [
  'app:todo-created',
  'app:navigate',
  'app:update-available',
  'app:update-downloaded',
  'app:toggle-ai',
  'app:data-changed',
  'app:settings-changed',
  'ai:stream',
  'ai:permission-request',
  // L4-G: human-in-the-loop events. The main-process waterfall listener
  // pushes these when a DSH tool calls ask_user_question / a guarded
  // tool needs binary approval. The renderer renders the matching
  // inline card and posts the answer back via aiUserQuestion.answer /
  // aiUserApproval.answer (defined below on the ThihyApi object).
  'ai:user-question-request',
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

const api: ThihyApi = {
  todo: {
    list: (filter) => invoke('todo.list', { filter }),
    get: (id) => invoke('todo.get', { id }),
    create: (input) => invoke('todo.create', { input }),
    update: (id, patch) => invoke('todo.update', { id, patch }),
    delete: (id) => invoke('todo.delete', { id }),
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
  },
  drawing: {
    list: (todoId) => invoke('drawing.list', { todoId }),
    read: (id) => invoke('drawing.read', { id }),
    save: (todoId, scene, id, title) =>
      invoke('drawing.save', { todoId, scene, id, title }),
    delete: (id) => invoke('drawing.delete', { id }),
    setThumb: (id, dataUrl) => invoke('drawing.setThumb', { id, dataUrl }),
  },
  inbox: {
    attach: (args: InboxAttachArgs) => invoke('inbox.attach', args),
    attachBlob: (args: InboxAttachBlobArgs) => invoke('inbox.attachBlob', args),
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
  on: onAppEvent,
};

contextBridge.exposeInMainWorld('thihy', api);

// Allow-listed event channels for the renderer.
contextBridge.exposeInMainWorld('__thihy_event_channels__', APP_EVENTS);