// Offline verification of ThihyLlmAdapter's provider-native tool-call SSE parsing.
// Stubs globalThis.fetch with canned OpenAI + Anthropic SSE streams and asserts the
// adapter emits the correct tool-call StreamChunks (block-start/tool-call-delta/
// block-end tool-call/finish tool-calls) so the DSH agent loop would execute tools.
//
// Run: npx tsx --import ./spikes/test-adapter/register.mjs spikes/test-adapter/test.ts

import { ThihyLlmAdapter } from '../../src/main/dsh/llm-adapter';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm';

const toolSchema: ToolSchema = {
  name: 'todo.create',
  description: 'Create a TODO',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
};

const userMsg = createUserMessage({
  content: [{ type: 'text', text: 'create a todo titled x' }],
  source: { kind: 'user' },
});

const baseOpts: GenerateOptions = {
  provider: 'thihy',
  model: 'test-model',
  messages: [userMsg],
  system: 'You are a test assistant.',
  tools: [toolSchema],
  temperature: 0.6,
  maxTokens: 1024,
  sessionId: 'sess-test' as never,
};

// ---------- fetch stub ----------

let cannedBody = '';
function setSSE(events: string[]): void {
  cannedBody = events.map((e) => e + '\n\n').join('');
}

const fetchStub = ((_url: string | URL, _init?: unknown) =>
  Promise.resolve(
    new Response(cannedBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )) as typeof fetch;

// ---------- helpers ----------

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function drive(adapter: ThihyLlmAdapter, opts: GenerateOptions) {
  const chunks: any[] = [];
  for await (const c of adapter.stream(opts)) chunks.push(c);
  return chunks;
}

// ---------- OpenAI /chat/completions ----------

async function testOpenAI(): Promise<void> {
  console.log('\n[OpenAI tool_calls SSE]');
  globalThis.fetch = fetchStub as never;
  // Two argument fragments that concatenate to {"title":"x"}.
  setSSE([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"todo.create","arguments":"{\\"tit"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"le\\":\\"x\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    'data: [DONE]',
  ]);

  const adapter = new ThihyLlmAdapter({
    getEndpoint: () => ({ protocol: 'openai', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' } as never),
  });
  const chunks = await drive(adapter, baseOpts);

  const textDeltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert(textDeltas === 'Hello', `text deltas concatenate to "Hello" (got "${textDeltas}")`);

  const toolCallEnd = chunks.find(
    (c) => c.type === 'block-end' && c.block?.type === 'tool-call',
  );
  assert(!!toolCallEnd, 'a tool-call block-end was emitted');
  assert(toolCallEnd?.block?.name === 'todo.create', `tool name is todo.create (got "${toolCallEnd?.block?.name}")`);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(toolCallEnd?.block?.arguments ?? '');
  } catch {
    /* leave undefined */
  }
  assert(parsed !== undefined && (parsed as any).title === 'x', `tool arguments parse to {title:"x"} (got ${JSON.stringify(parsed)})`);

  const finish = chunks.find((c) => c.type === 'finish');
  assert(finish?.reason?.kind === 'tool-calls', `finish reason is tool-calls (got ${finish?.reason?.kind})`);

  const usage = chunks.find((c) => c.type === 'usage');
  assert(
    usage?.usage?.inputTokens === 10 && usage?.usage?.outputTokens === 5,
    `usage chunk carries prompt=10 completion=5 (got ${JSON.stringify(usage?.usage)})`,
  );
}

// ---------- Anthropic /v1/messages ----------

async function testAnthropic(): Promise<void> {
  console.log('\n[Anthropic tool_use SSE]');
  globalThis.fetch = fetchStub as never;
  setSSE([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_2","name":"todo.list"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"limit\\":5}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ]);

  const adapter = new ThihyLlmAdapter({
    getEndpoint: () => ({ protocol: 'anthropic', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' } as never),
  });
  const chunks = await drive(adapter, baseOpts);

  const textDeltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert(textDeltas === 'Hi', `text deltas concatenate to "Hi" (got "${textDeltas}")`);

  const toolCallEnd = chunks.find(
    (c) => c.type === 'block-end' && c.block?.type === 'tool-call',
  );
  assert(!!toolCallEnd, 'a tool-call block-end was emitted');
  assert(toolCallEnd?.block?.name === 'todo.list', `tool name is todo.list (got "${toolCallEnd?.block?.name}")`);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(toolCallEnd?.block?.arguments ?? '');
  } catch {
    /* leave undefined */
  }
  assert(parsed !== undefined && (parsed as any).limit === 5, `tool arguments parse to {limit:5} (got ${JSON.stringify(parsed)})`);

  const finish = chunks.find((c) => c.type === 'finish');
  assert(finish?.reason?.kind === 'tool-calls', `finish reason is tool-calls (got ${finish?.reason?.kind})`);

  const usage = chunks.find((c) => c.type === 'usage');
  assert(
    usage?.usage?.inputTokens === 10 && usage?.usage?.outputTokens === 8,
    `usage chunk carries input=10 output=8 (got ${JSON.stringify(usage?.usage)})`,
  );
}

// ---------- no-endpoint guard ----------

async function testNoEndpoint(): Promise<void> {
  console.log('\n[no-endpoint guard]');
  const adapter = new ThihyLlmAdapter({ getEndpoint: () => null });
  const chunks = await drive(adapter, baseOpts);
  const finish = chunks.find((c) => c.type === 'finish');
  assert(finish?.reason?.kind === 'error', `finish reason is error when no endpoint (got ${finish?.reason?.kind})`);
  assert(!!finish?.reason?.failure?.message, 'error failure carries a message');
}

// ---------- run ----------

await testOpenAI();
await testAnthropic();
await testNoEndpoint();

if (process.exitCode) {
  console.log('\n❌ ADAPTER TESTS FAILED');
} else {
  console.log('\n✅ ALL ADAPTER TESTS PASSED');
}
