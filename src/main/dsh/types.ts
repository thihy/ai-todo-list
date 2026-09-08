// DSH container — shared types.

import type { AIModel } from '../../shared/ai-types';

// Model is a free string so the user can configure arbitrary providers/models
// via settings; DSH forwards it to whichever provider is selected.
export type { AIModel };

/** Eagerly-bootstrapped handle answering the non-streaming AI IPC calls.
 *
 *  The real agent loop (boot + adapter + tools + runTurn) lives in
 *  `dsh-runtime.ts getDshRuntime()` and is invoked lazily on the first
 *  `ai.ask` because it needs a resolved endpoint. This handle needs no
 *  creds — `ai.health` then probes the real endpoint on demand. */
export interface DshHandle {
  health(): { ok: boolean; mode: 'real' | 'shim' };
  /** Hint list shown in the model picker. Real usage flows through DSH
   *  agent + adapter; this is just a UI fallback for `ai.models`. */
  models(): AIModel[];
}
