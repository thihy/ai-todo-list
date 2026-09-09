// Endpoint resolution + health probe for the AI channels.
//
// This module is the *only* place that knows about provider/protocol details —
// DSH's TodoListLlmAdapter reads ResolvedEndpoint at stream time (one call per
// turn) so the user can change providers/keys without restarting. ai.health
// uses the same resolver to probe reachability with a /models GET.
//
// History: an earlier `client.ts` carried a full OpenAI/Anthropic streaming
// shim here; that path was replaced by TodoListLlmAdapter + DSH's agent loop,
// leaving only resolveEndpoint + healthCheck. The shim's helpers (sseData,
// safeText, httpError, openAIHeaders) now live in `http.ts`.

import { logger } from '../logger';
import type { AIProvider, AICustomProtocol, CustomProviderConfig } from '../../shared/ai-types';

/** Built-in provider → default endpoint. */
const BUILTIN_ENDPOINTS: Record<
  Exclude<AIProvider, 'custom' | 'shim'>,
  { protocol: AICustomProtocol; baseUrl: string }
> = {
  deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  openai: { protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  ollama: { protocol: 'openai', baseUrl: 'http://localhost:11434/v1' },
};

export interface ResolvedEndpoint {
  protocol: AICustomProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolve the concrete endpoint from persisted settings. Returns null for the
 * `shim` provider (no real call) or when `custom` has no usable instance.
 */
export function resolveEndpoint(s: {
  provider: AIProvider;
  customProviders: CustomProviderConfig[];
  customProviderId: string | null;
  apiKey: string | null;
  model: string;
}): ResolvedEndpoint | null {
  if (s.provider === 'shim') return null;
  if (s.provider === 'custom') {
    // Active instance by id, else the first one as a fallback. No instance at
    // all → not configured.
    const inst =
      s.customProviders.find((c) => c.id === s.customProviderId) ?? s.customProviders[0];
    if (!inst) return null;
    const baseUrl = inst.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) return null;
    return {
      protocol: inst.protocol,
      baseUrl,
      apiKey: inst.apiKey,
      model: inst.model,
    };
  }
  const built = BUILTIN_ENDPOINTS[s.provider];
  return {
    protocol: built.protocol,
    baseUrl: built.baseUrl,
    apiKey: s.provider === 'ollama' ? '' : (s.apiKey ?? ''),
    model: s.model,
  };
}

export async function healthCheck(ep: ResolvedEndpoint): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    let res: Response;
    if (ep.protocol === 'anthropic') {
      res = await fetch(`${ep.baseUrl}/v1/models`, {
        headers: { 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' },
      });
    } else {
      const headers: Record<string, string> = {};
      if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
      res = await fetch(`${ep.baseUrl}/models`, { headers });
    }
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn(`health check failed: ${(err as Error).message}`);
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}
