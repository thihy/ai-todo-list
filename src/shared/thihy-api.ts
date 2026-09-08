// Renderer-side typed facade for the contextBridge `window.thihy` API.

import type {
  IpcChannelName,
  IpcRequest,
  IpcResponse,
} from './ipc-schema';
import type { AIModel, AIProvider, AICustomProtocol, CustomProviderInput, CustomProviderView, AIStreamEvent, PermissionRequest } from './ai-types';
import type { Todo, TodoCreate, TodoPatch, TodoFilter, SearchHit, TodoStats } from './todo-types';
import type { ContentVersionEntry } from './todo-types';
import type { DrawingMeta, DrawingScene } from './todo-types';
import type { Group, GroupCreate, GroupPatch } from './todo-types';

// --- App events pushed from main ---

export type AppEvent =
  | 'app:todo-created'
  | 'app:navigate'
  | 'app:update-available'
  | 'app:update-downloaded'
  | 'app:toggle-ai'
  | 'ai:stream'
  | 'ai:permission-request';

export interface AppEventMap {
  'app:todo-created': { id: string };
  'app:navigate': { route: string };
  'app:update-available': { version: string };
  'app:update-downloaded': { version: string };
  'app:toggle-ai': Record<string, never>;
  'ai:stream': AIStreamEvent;
  'ai:permission-request': PermissionRequest;
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
}

// --- ThihyApi ---

export interface ThihyApi {
  todo: {
    list(filter: TodoFilter): Promise<IpcResponse<'todo.list'>>;
    get(id: string): Promise<IpcResponse<'todo.get'>>;
    create(input: TodoCreate): Promise<IpcResponse<'todo.create'>>;
    update(id: string, patch: TodoPatch): Promise<IpcResponse<'todo.update'>>;
    delete(id: string): Promise<IpcResponse<'todo.delete'>>;
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
  group: {
    list(): Promise<IpcResponse<'group.list'>>;
    create(input: GroupCreate): Promise<IpcResponse<'group.create'>>;
    update(id: string, patch: GroupPatch): Promise<IpcResponse<'group.update'>>;
    delete(id: string): Promise<IpcResponse<'group.delete'>>;
  };
  settings: {
    get(): Promise<IpcResponse<'settings.get'>>;
    set(patch: SettingsPatchArgs): Promise<IpcResponse<'settings.set'>>;
    chooseDataDir(): Promise<IpcResponse<'settings.chooseDataDir'>>;
  };
  app: {
    /** Pop the native application menu at the cursor (title-bar 菜单 button). */
    popupMenu(): Promise<IpcResponse<'app.popupMenu'>>;
    /** User-menu actions (bottom-left chip). */
    action(a: 'about' | 'checkUpdate' | 'quit'): Promise<IpcResponse<'app.action'>>;
  };
  capture: {
    submit(args: CaptureSubmitArgs): Promise<IpcResponse<'capture.submit'>>;
  };
  ai: {
    health(): Promise<IpcResponse<'ai.health'>>;
    models(): Promise<IpcResponse<'ai.models'>>;
    cancel(invocationId: string): Promise<IpcResponse<'ai.cancel'>>;
    ask(req: { prompt: string; model?: AIModel; tools?: string[]; invocationId?: string }): Promise<IpcResponse<'ai.ask'>>;
    /** Rule-based NL capture preview (works offline; returns structured fields). */
    parseCapturePreview(text: string): Promise<IpcResponse<'ai.parseCapturePreview'>>;
  };
  on<E extends AppEvent>(event: E, cb: (payload: AppEventMap[E]) => void): () => void;
}

// Re-exports for renderer convenience.
export type { Todo, TodoCreate, TodoPatch, TodoFilter, SearchHit, TodoStats };
export type { ContentVersionEntry };
export type { DrawingMeta, DrawingScene };
export type { Group, GroupCreate, GroupPatch };
export type { AIModel, AIProvider, AICustomProtocol, CustomProviderInput, CustomProviderView, AIStreamEvent, PermissionRequest };
export type { IpcChannelName, IpcRequest, IpcResponse };