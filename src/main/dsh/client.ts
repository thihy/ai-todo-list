// DSH client — direct HTTP calls to OpenAI-compatible, OpenAI Responses, and
// Anthropic Messages APIs behind the same streaming protocol the renderer
// consumes. Built-in providers derive {protocol, baseUrl} implicitly; the
// `custom` provider reads them from settings. Real DSH uses its own gateway;
// this is the thin glue for when DSH falls back to direct API calls.

import { logger } from '../logger';
import type { DshInvocationRequest, DshInvocationResult } from './types';
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

export async function invokeChat(
  ep: ResolvedEndpoint,
  req: DshInvocationRequest,
  onToken: (text: string) => void,
): Promise<DshInvocationResult> {
  switch (ep.protocol) {
    case 'openai':
      return invokeOpenAIChat(ep, req, onToken);
    case 'openresponses':
      return invokeOpenAIResponses(ep, req, onToken);
    case 'anthropic':
      return invokeAnthropic(ep, req, onToken);
  }
}

// ---------- OpenAI /chat/completions (DeepSeek, OpenAI, Ollama) ----------

async function invokeOpenAIChat(
  ep: ResolvedEndpoint,
  req: DshInvocationRequest,
  onToken: (text: string) => void,
): Promise<DshInvocationResult> {
  const url = `${ep.baseUrl}/chat/completions`;
  const body = {
    model: req.model,
    messages: [
      ...(req.systemPrompt ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
      ...req.messages,
    ],
    stream: true,
    temperature: 0.6,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: chatHeaders(ep),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw httpError('OpenAI chat', res, await safeText(res));

  let full = '';
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = parsed.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        full += delta;
        onToken(delta);
      }
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
        completionTokens = parsed.usage.completion_tokens ?? completionTokens;
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return result(req, ep, full, promptTokens, completionTokens);
}

// ---------- OpenAI Responses (/responses) ----------

async function invokeOpenAIResponses(
  ep: ResolvedEndpoint,
  req: DshInvocationRequest,
  onToken: (text: string) => void,
): Promise<DshInvocationResult> {
  const url = `${ep.baseUrl}/responses`;
  const body = {
    model: req.model,
    input: req.messages,
    ...(req.systemPrompt ? { instructions: req.systemPrompt } : {}),
    stream: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: chatHeaders(ep),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw httpError('OpenAI Responses', res, await safeText(res));

  let full = '';
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as {
        type?: string;
        delta?: string;
        response?: { usage?: { input_tokens?: number; output_tokens?: number } };
      };
      if (parsed.type === 'response.output_text.delta' && parsed.delta) {
        full += parsed.delta;
        onToken(parsed.delta);
      } else if (parsed.type === 'response.completed' && parsed.response?.usage) {
        promptTokens = parsed.response.usage.input_tokens ?? promptTokens;
        completionTokens = parsed.response.usage.output_tokens ?? completionTokens;
      } else if (parsed.type === 'response.failed') {
        throw new Error('Responses stream failed');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Responses stream failed') throw err;
    }
  }
  return result(req, ep, full, promptTokens, completionTokens);
}

// ---------- Anthropic Messages (/v1/messages) ----------

async function invokeAnthropic(
  ep: ResolvedEndpoint,
  req: DshInvocationRequest,
  onToken: (text: string) => void,
): Promise<DshInvocationResult> {
  const url = `${ep.baseUrl}/v1/messages`;
  const body = {
    model: req.model,
    max_tokens: 4096,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    messages: req.messages,
    stream: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ep.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw httpError('Anthropic', res, await safeText(res));

  let full = '';
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const data of sseData(res.body)) {
    try {
      const parsed = JSON.parse(data) as {
        type?: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        full += parsed.delta.text;
        onToken(parsed.delta.text);
      } else if (parsed.type === 'message_start' && parsed.message?.usage) {
        promptTokens = parsed.message.usage.input_tokens ?? promptTokens;
      } else if (parsed.type === 'message_delta' && parsed.usage) {
        completionTokens = parsed.usage.output_tokens ?? completionTokens;
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return result(req, ep, full, promptTokens, completionTokens);
}

// ---------- shared helpers ----------

function chatHeaders(ep: ResolvedEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

/** Async generator yielding the JSON payload of each SSE `data:` line. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
    // flush trailing line without newline
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function httpError(label: string, res: Response, text: string): Error {
  return new Error(`${label} ${res.status}: ${text || res.statusText}`);
}

function result(
  req: DshInvocationRequest,
  ep: ResolvedEndpoint,
  full: string,
  promptTokens: number,
  completionTokens: number,
): DshInvocationResult {
  return {
    invocationId: req.invocationId,
    content: full,
    toolCalls: [],
    costUsd: estimateCost(ep.model, promptTokens, completionTokens),
    usage: { promptTokens, completionTokens },
  };
}

function estimateCost(model: string, prompt: number, completion: number): number {
  // DeepSeek pricing (USD per 1M tokens). Unknown models cost 0 — the UI shows
  // accrual only for known models.
  const rates: Record<string, { p: number; c: number }> = {
    'deepseek-chat': { p: 0.27, c: 1.1 },
    'deepseek-reasoner': { p: 0.55, c: 2.19 },
  };
  const r = rates[model];
  if (!r) return 0;
  return (prompt * r.p + completion * r.c) / 1_000_000;
}

export function makeSystemPrompt(): string {
  return [
    'You are thihy, an AI assistant inside a personal TODO list app.',
    'When the user asks about their work, prefer calling tools (todo.*, content.*, drawing.*) to ground your answer in real data.',
    'For destructive actions (todo.delete, drawing.delete, content.restoreVersion), describe what you would do and wait for explicit user approval via the permission gate.',
    'For notify+undo actions (todo.update, todo.create, content.writeBody), the app will surface an undo toast for 8 seconds after the action commits.',
    'Be concise; prefer bullet points and short paragraphs. Use the user language.',
  ].join('\n');
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
