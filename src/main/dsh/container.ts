// DSH container — a thin bootstrap-time handle exposing health/models/cancel to
// the IPC layer. The REAL agent loop (boot + adapter + tools + runTurn) is lazy
// and lives in `dsh-runtime.ts getDshRuntime()`, invoked on the first `ai.ask`.
// That split is deliberate: getDshRuntime needs a resolved endpoint (user creds
// in settings), which is not available at bootstrap. This handle needs no creds,
// so it boots eagerly and never logs a spurious "failed" — it simply reports
// `mode: 'dsh'` and lets `ai.health`'s real endpoint probe decide ok/not-ok.

import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { SettingsStore } from '../settings/store';
import type Database from 'better-sqlite3';
import type { DshContainer, DshHandle } from './types';
import { logger } from '../logger';

export interface InitArgs {
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  settings: SettingsStore;
  db: Database.Database;
}

/**
 * Build the bootstrap DSH handle. The real agent runtime is bootstrapped lazily
 * by `getDshRuntime()` on the first `ai.ask`; this handle only answers the
 * non-streaming `ai.health` / `ai.models` / `ai.cancel` IPC calls.
 */
export async function initDshContainer(_args: InitArgs): Promise<DshHandle> {
  logger.info('DSH handle ready (real runtime is lazy on first ai.ask)');
  const container: DshContainer = bootBootstrapHandle();
  return {
    container,
    invoke: (req) => container.invoke(req),
    cancel: (id) => container.cancel(id),
    models: () => container.models(),
    health: () => container.health(),
  };
}

/** Thin handle: cancel is a stub (runTurn owns its own lifecycle); models is a
 *  hint list; invoke is never called (ai.ask uses getDshRuntime). */
function bootBootstrapHandle(): DshContainer {
  return {
    invoke: async () => {
      throw new Error('container.invoke is unused — ai.ask goes through getDshRuntime');
    },
    cancel: () => undefined,
    models: () => ['deepseek-chat', 'deepseek-reasoner'],
    health: () => ({ ok: true, mode: 'real' as const }),
    registerTool: () => undefined,
  };
}
