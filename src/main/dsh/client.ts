// DSH client — wraps the deepseek API behind the same stream protocol used in renderer.
// Real DSH uses its own gateway; this is the thin glue for when DSH falls back to direct API calls.

import { logger } from '../logger';
import type { DshInvocationRequest, DshInvocationResult } from './types';

const DEFAULT_BASE = 'https://api.deepseek.com/v1';

export async function invokeDeepSeek(
  apiKey: string,
  req: DshInvocationRequest,
  onToken: (text: string) => void,
): Promise<DshInvocationResult> {
  const url = `${DEFAULT_BASE}/chat/completions`;
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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${text || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
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
  }

  const costUsd = estimateCost(req.model, promptTokens, completionTokens);
  return {
    invocationId: req.invocationId,
    content: full,
    toolCalls: [],
    costUsd,
    usage: { promptTokens, completionTokens },
  };
}

function estimateCost(model: string, prompt: number, completion: number): number {
  // DeepSeek pricing (USD per 1M tokens) — kept in sync with public pricing.
  const rates: Record<string, { p: number; c: number }> = {
    'deepseek-chat': { p: 0.27, c: 1.1 },
    'deepseek-reasoner': { p: 0.55, c: 2.19 },
  };
  const r = rates[model] ?? rates['deepseek-chat'];
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

export async function healthCheck(apiKey: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${DEFAULT_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn(`health check failed: ${(err as Error).message}`);
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}
