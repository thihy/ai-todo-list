// DSH container — a thin bootstrap-time handle exposing health/models to the
// IPC layer. The REAL agent loop (boot + adapter + tools + runTurn) is lazy
// and lives in `dsh-runtime.ts getDshRuntime()`, invoked on the first `ai.ask`.
// That split is deliberate: getDshRuntime needs a resolved endpoint (user
// creds in settings), which is not available at bootstrap. This handle needs
// no creds, so it boots eagerly and never logs a spurious "failed" — it
// simply reports `mode: 'real'` and lets `ai.health`'s real endpoint probe
// decide ok/not-ok.

import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { SettingsStore } from '../settings/store';
import type Database from 'better-sqlite3';
import type { DshHandle, AIModel } from './types';
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
 * non-streaming `ai.health` / `ai.models` IPC calls.
 *
 * Note: `ai.cancel` is handled directly by `getDshRuntime().cancel()` in
 * ai-handlers — this eager handle does not own a cancel surface.
 */
export async function initDshContainer(_args: InitArgs): Promise<DshHandle> {
  logger.info('DSH handle ready (real runtime is lazy on first ai.ask)');
  return {
    health: () => ({ ok: true, mode: 'real' as const }),
    models: () => DEFAULT_MODEL_HINTS,
  };
}

/** Hint list shown in the model picker. Real model discovery happens through
 *  the configured provider — DSH's adapter passes the chosen id verbatim. */
const DEFAULT_MODEL_HINTS: AIModel[] = ['deepseek-chat', 'deepseek-reasoner'];
