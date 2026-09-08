// IPC channel validator. Rejects channels not declared in IpcRegistry.

import type { IpcChannelName, IpcRegistry, IpcRequest, IpcResponse } from './ipc-schema';

const DECLARED_CHANNELS: ReadonlySet<string> = new Set([
  'todo.list',
  'todo.get',
  'todo.create',
  'todo.update',
  'todo.delete',
  'todo.batchUpdate',
  'todo.search',
  'todo.stats',
  'content.readBody',
  'content.writeBody',
  'content.history',
  'content.restoreVersion',
  'drawing.list',
  'drawing.read',
  'drawing.save',
  'drawing.delete',
  'drawing.setThumb',
  'inbox.attach',
  'inbox.attachBlob',
  'group.list',
  'group.create',
  'group.update',
  'group.delete',
  'ai.cancel',
  'ai.ask',
  'ai.health',
  'ai.models',
  'ai.getMemory',
  'ai.forgetMemory',
  'ai.event',
  'ai.parseCapturePreview',
  'ai.conversation.list',
  'ai.conversation.create',
  'ai.conversation.rename',
  'ai.conversation.archive',
  'ai.conversation.unarchive',
  'ai.conversation.delete',
  'ai.conversation.confirmDelete',
  'ai.conversation.history',
  'permission.prompt',
  'permission.respond',
  'settings.get',
  'settings.set',
  'settings.chooseDataDir',
  'capture.submit',
  'app.popupMenu',
  'app.popupMenuCategory',
  'app.action',
]);

export function isKnownChannel(name: string): name is IpcChannelName {
  return DECLARED_CHANNELS.has(name);
}

export function assertKnownChannel<C extends IpcChannelName>(name: C): C {
  if (!isKnownChannel(name)) {
    throw new Error(`unknown_channel: ${name}`);
  }
  return name;
}

export type ChannelMap = IpcRegistry;
export type ReqOf<C extends IpcChannelName> = IpcRequest<C>;
export type ResOf<C extends IpcChannelName> = IpcResponse<C>;