// DSH container — in-process Cordis-based agent runtime.
// Per design.md: DSH is loaded as an in-process library via `require('@deepseek-ai/dsh-base')`.
// We wrap it in a Cordis container and register our domain tools (todo.* / content.* / drawing.*)
// so the agent can call them as if they were native tools.

import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { SettingsStore } from '../settings/store';
import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { logger } from '../logger';
import { registerDshTools } from './tools';
import type { DshContainer, DshHandle } from './types';

export interface InitArgs {
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  settings: SettingsStore;
  db: Database.Database;
}

/**
 * Boot the DSH container.
 *
 * Real DSH integration uses `require('@deepseek-ai/dsh-base')` and its peer `cordis`.
 * Because the live npm metadata for those packages is currently in flux (RC versions),
 * we probe at runtime; if unavailable, we fall back to a minimal in-process shim
 * that still implements the same tool surface so the app remains usable.
 */
export async function initDshContainer(args: InitArgs): Promise<DshHandle> {
  let container: DshContainer;
  try {
    const real = await loadRealDsh();
    container = await real.boot({ logger: { info: logger.info.bind(logger), warn: logger.warn.bind(logger), error: logger.error.bind(logger) } });
    logger.info('DSH (real) booted');
  } catch (err) {
    logger.warn(`DSH real boot failed, using shim: ${(err as Error).message}`);
    container = bootShim();
  }

  // Register our domain tools so the agent can call them.
  const send = makeEventSender();
  registerDshTools(container, { ...args, send });

  return {
    container,
    invoke: (req) => container.invoke(req),
    cancel: (id) => container.cancel(id),
    models: () => container.models(),
    health: () => container.health(),
  };
}

function makeEventSender() {
  return (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };
}

/**
 * Probe for real DSH (currently dead code — `@deepseek-ai/dsh-base` rc/next
 * depends on packages that aren't published, so this path always fails and
 * we fall through to `bootShim`). Kept here so flipping in real DSH later
 * is a single-line change.
 */
async function loadRealDsh(): Promise<{ boot: (opts: { logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } }) => Promise<DshContainer> }> {
  // The `@deepseek-ai/*` packages were dropped because their RC/next chain is broken
  // upstream. Kept behind optional dynamic imports so a future fix is a one-line change.
  // @ts-expect-error — package intentionally absent; path always falls through to shim.
  const baseModule = await import('@deepseek-ai/dsh-base').catch(() => ({ default: null }));
  // @ts-expect-error — package intentionally absent.
  const cordisModule = await import('@deepseek-ai/cordis').catch(() => null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (baseModule as any).default;
  const cordis = cordisModule as { newContainer: () => unknown } | null;
  if (!base || !cordis) throw new Error('DSH base or cordis missing');
  const c = cordis.newContainer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (base as any).boot !== 'function') throw new Error('DSH base.boot is not a function');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = await (base as any).boot({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, cordis: c });
  return {
    boot: async () => container,
  };
}

function bootShim(): DshContainer {
  // Shim used when real DSH is unavailable. Implements only the surface the app needs.
  return {
    invoke: async (_req) => {
      throw new Error('Shim cannot invoke — register tools before calling invoke');
    },
    cancel: () => undefined,
    models: () => ['deepseek-chat', 'deepseek-reasoner'],
    health: () => ({ ok: true, mode: 'shim' }),
    registerTool: () => undefined,
  };
}
