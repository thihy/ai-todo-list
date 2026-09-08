// Model → USD price per million tokens. Used to compute `costUsd` from the
// `TokenUsage` the DSH session logs after each assistant step.
//
// Prices are DeepSeek's published public rates (USD per 1M tokens, cache
// miss), as of 2026. They are hardcoded — the alternative (a network call
// to a pricing service) is a worse tradeoff than stale prices that the user
// can override via the model string when needed. Unknown models (custom
// providers, ollama, deepseek-r1, etc.) return null so we never fabricate
// cost on uncertain ground.
//
// If you need to add a new official model, append it here. For unofficial
// routing or markup, the upstream custom-provider config can absorb it later.

import type { TokenUsage } from '@deepseek-ai/dsh-llm';

interface ModelPrice {
  /** USD per 1M input tokens, cache miss. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const TABLE: Record<string, ModelPrice> = {
  'deepseek-chat':     { inputPerMTok: 0.27,  outputPerMTok: 1.10  },
  'deepseek-reasoner': { inputPerMTok: 0.27,  outputPerMTok: 1.10  },
};

/** Look up pricing for a model id. Returns null when the model is unknown —
 *  callers must surface "0 cost" instead of guessing. */
export function pricingFor(model: string): ModelPrice | null {
  return TABLE[model] ?? null;
}

/** Compute USD cost from a single TokenUsage block under a model's price.
 *  Unknown model → 0. Missing usage fields → 0 for that side (avoids NaN
 *  through `undefined / 1_000_000`). */
export function costForUsage(model: string, usage: TokenUsage): number {
  const p = pricingFor(model);
  if (!p) return 0;
  const inTok  = usage.inputTokens  ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const inCost  = (inTok  / 1_000_000) * p.inputPerMTok;
  const outCost = (outTok / 1_000_000) * p.outputPerMTok;
  return inCost + outCost;
}