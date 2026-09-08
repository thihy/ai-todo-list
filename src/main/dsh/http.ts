// Shared HTTP helpers for the LLM transports.
//
// Used by ThihyLlmAdapter (the production OpenAI/Anthropic wire path) and by
// spike scripts that need to replay or mock a streaming call. Kept tiny and
// dependency-free so it can run in any Node-side environment.

import type { ResolvedEndpoint } from './endpoints';

/** Authorization + content-type headers for the OpenAI-compatible wire path. */
export function openAIHeaders(ep: ResolvedEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

/** Async generator yielding the JSON payload of each SSE `data:` line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

/** Best-effort error-body read; never throws. */
export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Format an HTTP error with the response status + body text. */
export function httpError(label: string, res: Response, text: string): Error {
  return new Error(`${label} ${res.status}: ${text || res.statusText}`);
}
