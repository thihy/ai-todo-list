// ThihyLlmAdapter — the custom DSH LLM adapter that wraps our existing
// 3-protocol HTTP transport (client.ts) so DSH's agent loop drives the user's
// configured providers. This is the seam that lets us drop dsh-llm-deepseek /
// dsh-llm-pi-ai: we register one adapter for the 'thihy' route and resolve the
// real endpoint from settings at call time.
//
// The adapter must emit provider-native tool-calling chunks (tool-call-delta +
// block-end ToolCallBlock + finish tool-calls) so the agent loop executes our
// registered todo/content/drawing tools. client.ts's invokeChat is text-only,
// so this module owns the tool-aware streaming + multi-turn message mapping.
//
// VERIFY: the chunk protocol + loop plumbing are proven in
// spikes/dsh-fulltree/boot-mock.ts. The provider-wire tool-call SSE parsing
// here follows the public OpenAI/Anthropic streaming specs but needs a live
// tool-calling-capable model (deepseek-chat/gpt-4o/claude-sonnet) + user
// baseURL+apiKey to exercise end-to-end.

import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import type {
  GenerateOptions,
  StreamChunk,
  ToolSchema,
  Message,
  ContentBlock,
} from '@deepseek-ai/dsh-llm';
import type { ResolvedEndpoint } from './endpoints';
import { openAIHeaders, sseData, safeText, httpError } from './http';
import { logger } from '../logger';

/** Provider-native tool spec derived from DSH's neutral ToolSchema. */
type ProviderTool =
  | { protocol: 'openai'; tools: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] }
  | { protocol: 'anthropic'; tools: { name: string; description: string; input_schema: Record<string, unknown> }[] };

/** Settings accessor the adapter reads at each call to resolve the endpoint. */
export interface AdapterDeps {
  /** Resolve the live endpoint from persisted settings, or null if unconfigured. */
  getEndpoint: () => ResolvedEndpoint | null;
}

export class ThihyLlmAdapter extends LlmAdapter {
  constructor(private readonly deps: AdapterDeps) {
    super();
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'thihy (OpenAI/Anthropic compatible)' };
  }

  override async listModels() {
    return [];
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const ep = this.deps.getEndpoint();
    if (!ep) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'No LLM endpoint configured (set provider/API key in settings).', code: 'NO_ENDPOINT' } } };
      return;
    }
    // Honour DSH's abort signal: bail if already aborted, and stop iterating
    // once it fires mid-stream (cooperative — the fetch body is released on
    // return, which cancels the HTTP request on Node 22).
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted before dispatch', code: 'ABORTED' } } };
      return;
    }

    try {
      if (ep.protocol === 'anthropic') {
        yield* this.streamAnthropic(ep, options);
      } else {
        // openai + openresponses both use the OpenAI Chat SSE shape for
        // tool_calls; openresponses' /responses wire format differs, so route
        // it through the openai /chat/completions path when tools are present
        // (DeepSeek/OpenAI/Ollama all land here). Pure openresponses text-only
        // is handled by client.ts invokeChat fallback in ai-handlers.
        yield* this.streamOpenAI(ep, options);
      }
    } catch (err) {
      const message = (err as Error).message;
      logger.warn(`ThihyLlmAdapter stream error: ${message}`);
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'STREAM_ERROR' } } };
    }
  }

  // ---------- OpenAI /chat/completions (DeepSeek, OpenAI, Ollama) ----------

  private async *streamOpenAI(ep: ResolvedEndpoint, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const url = `${ep.baseUrl}/chat/completions`;
    const messages = toOpenAIMessages(options);
    const providerTools = toProviderTools('openai', options.tools);
    const body: Record<string, unknown> = {
      model: options.model || ep.model,
      messages,
      stream: true,
      temperature: options.temperature ?? 0.6,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop ? { stop: options.stop } : {}),
      ...(providerTools.tools.length ? { tools: providerTools.tools } : {}),
      // Request usage in the final chunk so we can emit a usage chunk.
      stream_options: { include_usage: true },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: openAIHeaders(ep),
      body: JSON.stringify(body),
      signal: options.signal ?? undefined,
    });
    if (!res.ok || !res.body) {
      const text = await safeText(res);
      throw httpError('OpenAI chat', res, text);
    }

    // Per-index accumulator for tool-call arguments; OpenAI streams tool_calls
    // as incremental JSON-argument fragments keyed by `index`.
    const toolAcc = new Map<number, { id: string; name: string; args: string; started: boolean }>();
    let blockSeq = 0; // next block index for text
    let textOpen = false;
    let reasoningOpen = false;
    let reasoningText = '';
    let reasoningIdx = -1;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishKind: 'stop' | 'tool-calls' = 'stop';

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') continue;
      let parsed: {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
        completionTokens = parsed.usage.completion_tokens ?? completionTokens;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;

      // Reasoning (thinking) — glm-5.2 / deepseek-reasoner emit reasoning_content
      // BEFORE the visible answer. Stream it as a distinct reasoning block so the
      // UI can show a collapsible "思考过程" panel separate from the answer.
      const reasoning = choice.delta?.reasoning_content;
      if (reasoning) {
        if (!reasoningOpen) {
          // Close any open text block first (defensive; reasoning normally leads).
          if (textOpen) {
            yield { type: 'block-end', index: blockSeq, block: { type: 'text', text: '' } };
            textOpen = false;
            blockSeq++;
          }
          reasoningIdx = blockSeq;
          yield { type: 'block-start', index: reasoningIdx, blockType: 'reasoning' };
          reasoningOpen = true;
        }
        reasoningText += reasoning;
        yield { type: 'reasoning-delta', index: reasoningIdx, text: reasoning };
        // A delta carrying reasoning rarely also carries content; keep them
        // mutually exclusive per-chunk for clean block boundaries.
        continue;
      }
      // Transitioning away from reasoning (or never reasoned) — close the block.
      if (reasoningOpen) {
        yield { type: 'block-end', index: reasoningIdx, block: { type: 'reasoning', text: reasoningText } };
        reasoningOpen = false;
        blockSeq = reasoningIdx + 1;
      }

      // Text delta — open a text block lazily on first non-empty content.
      const text = choice.delta?.content;
      if (text) {
        if (!textOpen) {
          yield { type: 'block-start', index: blockSeq, blockType: 'text' };
          textOpen = true;
        }
        yield { type: 'text-delta', index: blockSeq, text };
      }

      // Tool-call deltas.
      for (const tc of choice.delta?.tool_calls ?? []) {
        let acc = toolAcc.get(tc.index);
        if (!acc) {
          acc = { id: '', name: '', args: '', started: false };
          toolAcc.set(tc.index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        // Close any open text block before starting a tool-call block.
        if (textOpen) {
          yield { type: 'block-end', index: blockSeq, block: { type: 'text', text: '' } };
          textOpen = false;
          blockSeq++;
        }
        if (!acc.started) {
          // Synthesize a stable id when the provider omits it (some Ollama builds).
          acc.id = acc.id || `call_${tc.index}`;
          acc.started = true;
          yield { type: 'block-start', index: blockSeq + tc.index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: blockSeq + tc.index, id: ToolCallId(acc.id) as never, name: acc.name, argumentsDelta: '' };
        }
        const argDelta = tc.function?.arguments ?? '';
        if (argDelta) {
          acc.args += argDelta;
          yield { type: 'tool-call-delta', index: blockSeq + tc.index, id: ToolCallId(acc.id) as never, argumentsDelta: argDelta };
        }
      }

      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') finishKind = 'tool-calls';
      }
    }

    // Close the open text block (if any) and then the assembled tool-call blocks.
    if (textOpen) {
      yield { type: 'block-end', index: blockSeq, block: { type: 'text', text: '' } };
      blockSeq++;
    }
    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'block-end', index: blockSeq, block: { type: 'tool-call', id: ToolCallId(acc.id) as never, name: acc.name, arguments: acc.args } };
      blockSeq++;
    }
    if (promptTokens || completionTokens) {
      yield { type: 'usage', usage: { inputTokens: promptTokens, outputTokens: completionTokens } };
    }
    yield { type: 'finish', reason: { kind: finishKind } };
  }

  // ---------- Anthropic /v1/messages ----------

  private async *streamAnthropic(ep: ResolvedEndpoint, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const url = `${ep.baseUrl}/v1/messages`;
    const { messages, system } = toAnthropicMessages(options);
    const providerTools = toProviderTools('anthropic', options.tools);
    const body: Record<string, unknown> = {
      model: options.model || ep.model,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      messages,
      ...(system ? { system } : {}),
      ...(options.stop ? { stop_sequences: options.stop } : {}),
      ...(providerTools.tools.length ? { tools: providerTools.tools } : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ep.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options.signal ?? undefined,
    });
    if (!res.ok || !res.body) {
      const text = await safeText(res);
      throw httpError('Anthropic', res, text);
    }

    // Anthropic streams content blocks by `index`: content_block_start opens a
    // block (text or tool_use), content_block_delta carries text_delta or
    // input_json_delta fragments, content_block_stop closes it.
    const blocks = new Map<number, { type: 'text' | 'tool-call'; id: string; name: string; args: string }>();
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const data of sseData(res.body)) {
      let parsed: {
        type?: string;
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
        index?: number;
        content_block?: { type?: string; id?: string; name?: string; input?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      switch (parsed.type) {
        case 'message_start':
          promptTokens = parsed.message?.usage?.input_tokens ?? promptTokens;
          break;
        case 'content_block_start': {
          const idx = parsed.index ?? 0;
          const cb = parsed.content_block;
          if (cb?.type === 'tool_use') {
            blocks.set(idx, { type: 'tool-call', id: cb.id ?? '', name: cb.name ?? '', args: '' });
            yield { type: 'block-start', index: idx, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index: idx, id: ToolCallId(cb.id ?? '') as never, name: cb.name, argumentsDelta: '' };
          } else {
            blocks.set(idx, { type: 'text', id: '', name: '', args: '' });
            yield { type: 'block-start', index: idx, blockType: 'text' };
          }
          break;
        }
        case 'content_block_delta': {
          const idx = parsed.index ?? 0;
          const d = parsed.delta;
          if (d?.type === 'text_delta' && d.text) {
            yield { type: 'text-delta', index: idx, text: d.text };
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const acc = blocks.get(idx);
            if (acc) acc.args += d.partial_json;
            yield { type: 'tool-call-delta', index: idx, id: ToolCallId(acc?.id ?? '') as never, argumentsDelta: d.partial_json };
          }
          break;
        }
        case 'content_block_stop': {
          const idx = parsed.index ?? 0;
          const acc = blocks.get(idx);
          if (acc?.type === 'tool-call') {
            yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: ToolCallId(acc.id) as never, name: acc.name, arguments: acc.args } };
          } else {
            yield { type: 'block-end', index: idx, block: { type: 'text', text: '' } };
          }
          break;
        }
        case 'message_delta':
          completionTokens = parsed.usage?.output_tokens ?? completionTokens;
          break;
        case 'message_stop':
          break;
      }
    }

    if (promptTokens || completionTokens) {
      yield { type: 'usage', usage: { inputTokens: promptTokens, outputTokens: completionTokens } };
    }
    // If any tool-call block was opened, the loop must run tools.
    const hasToolCalls = [...blocks.values()].some(b => b.type === 'tool-call');
    yield { type: 'finish', reason: hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' } };
  }
}

// ---------- shared message + tool translation (DSH neutral → provider wire) ----------

/** Extract plain text from a DSH Message's content blocks. */
function messageText(msg: Message): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** DSH messages → OpenAI chat messages (handles text + tool-call + tool-result). */
function toOpenAIMessages(options: GenerateOptions): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (options.system) out.push({ role: 'system', content: options.system });
  for (const msg of options.messages) {
    const text = messageText(msg);
    if (msg.role === 'assistant') {
      // An assistant turn may carry text and/or tool-call blocks.
      const toolCalls = msg.content.filter(b => b.type === 'tool-call');
      const entry: Record<string, unknown> = { role: 'assistant' };
      if (text) entry.content = text;
      if (toolCalls.length) {
        entry.tool_calls = (toolCalls as Extract<ContentBlock, { type: 'tool-call' }>[]).map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      out.push(entry);
      continue;
    }
    // user role — but a tool-result message is role 'user' with one tool-result block.
    const toolResult = msg.content.find(b => b.type === 'tool-result');
    if (toolResult && toolResult.type === 'tool-result') {
      const resultText = toolResult.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('');
      out.push({ role: 'tool', tool_call_id: toolResult.toolCallId, content: resultText || '{}' });
    } else {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** DSH messages → Anthropic messages (handles text + tool-use + tool-result). */
function toAnthropicMessages(options: GenerateOptions): { messages: Array<Record<string, unknown>>; system?: string } {
  const system = options.system;
  const messages: Array<Record<string, unknown>> = [];
  for (const msg of options.messages) {
    const text = messageText(msg);
    if (msg.role === 'assistant') {
      const content: unknown[] = [];
      if (text) content.push({ type: 'text', text });
      for (const b of msg.content) {
        if (b.type === 'tool-call') {
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: safeParseJSON(b.arguments) });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    // user role — tool-result blocks map to tool_result content.
    const toolResult = msg.content.find(b => b.type === 'tool-result');
    if (toolResult && toolResult.type === 'tool-result') {
      const resultText = toolResult.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('');
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolResult.toolCallId, content: resultText || '{}' }],
      });
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }
  }
  return { messages, system };
}

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function toProviderTools(protocol: 'openai' | 'anthropic', schemas: ToolSchema[] | undefined): ProviderTool {
  if (protocol === 'openai') {
    return {
      protocol: 'openai',
      tools: (schemas ?? []).map(s => ({
        type: 'function',
        function: { name: s.name, description: s.description, parameters: s.parameters },
      })),
    };
  }
  return {
    protocol: 'anthropic',
    tools: (schemas ?? []).map(s => ({
      name: s.name,
      description: s.description,
      input_schema: s.parameters,
    })),
  };
}
