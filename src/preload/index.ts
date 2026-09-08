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
  'ai:stream',
  'ai:permission-request',
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
  },
  settings: {
    get: () => invoke('settings.get', undefined as never),
    set: (patch: SettingsPatchArgs) => invoke('settings.set', patch),
    chooseDataDir: () => invoke('settings.chooseDataDir', undefined as never),
  },
  app: {
    popupMenu: () => invoke('app.popupMenu', undefined as never),
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
    cancel: (invocationId) => invoke('ai.cancel', { invocationId }),
    ask: (req) => invoke('ai.ask', req),
  },
  on: onAppEvent,
};

contextBridge.exposeInMainWorld('thihy', api);

// Allow-listed event channels for the renderer.
contextBridge.exposeInMainWorld('__thihy_event_channels__', APP_EVENTS);