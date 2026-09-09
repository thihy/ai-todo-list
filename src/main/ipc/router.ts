// Centralised IPC handler registration. Rejects unknown channels (spec §2.3, §desktop-runtime).

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { isKnownChannel } from '../../shared/channels';
import type {
  IpcChannelName,
  IpcRequest,
  IpcResponse,
  IpcResult,
} from '../../shared/ipc-schema';
import { logger } from '../logger';

type Handler<C extends IpcChannelName> = (
  event: IpcMainInvokeEvent,
  req: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

const handlers = new Map<string, Handler<IpcChannelName>>();

export function register<C extends IpcChannelName>(
  channel: C,
  handler: Handler<C>,
): void {
  if (!isKnownChannel(channel)) {
    throw new Error(`register: unknown_channel ${channel}`);
  }
  if (handlers.has(channel)) {
    throw new Error(`register: duplicate_channel ${channel}`);
  }
  handlers.set(channel, handler as unknown as Handler<IpcChannelName>);
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, code, message };
}

export function installRouter(): void {
  // Listen for any invoke; validate channel.
  const wrapped = new Proxy(
    {},
    {
      get: (_, channel: string) => {
        const handler = handlers.get(channel);
        return async (_event: IpcMainInvokeEvent, req: unknown) => {
          if (!isKnownChannel(channel)) {
            logger.warn(`unknown_channel rejected: ${channel}`);
            return fail('unknown_channel', `Channel not declared: ${channel}`);
          }
          if (!handler) {
            return fail('no_handler', `Channel declared but no handler: ${channel}`);
          }
          try {
            return await handler(_event, req as IpcRequest<IpcChannelName>);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`handler error on ${channel}: ${message}`);
            return fail('handler_error', message);
          }
        };
      },
    },
  );

  // We use ipcMain.handle with a single proxy channel so all calls go through one router.
  // Each renderer invokes through preload using the real channel string.
  ipcMain.handle('__todo_router__', async (event, channel: string, payload: unknown) => {
    const fn = (wrapped as Record<string, unknown>)[channel];
    if (typeof fn !== 'function') {
      logger.warn(`router: unknown_channel rejected: ${channel}`);
      return fail('unknown_channel', `Channel not declared: ${channel}`);
    }
    return (fn as (e: typeof event, p: unknown) => Promise<IpcResult<unknown>>)(event, payload);
  });
}

export function okResult<T>(data: T): IpcResult<T> {
  return ok(data);
}
export function failResult(code: string, message: string): IpcResult<never> {
  return fail(code, message);
}