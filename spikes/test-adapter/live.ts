// LIVE end-to-end runTurn test: boots the real DSH tree (resources/dsh/cordis.yml),
// registers the REAL ThihyLlmAdapter pointing at a live OpenAI-compatible gateway,
// registers one echo tool, and runs a full turn. Verifies the path that was
// broken by the session/event signature bug: live HTTP → adapter SSE parsing →
// tool-call chunks → agent loop executes the tool → result fed back → final
// text streams → corrected (session, event) handler forwards events.
//
// Run: npx tsx --import ./spikes/test-adapter/register.mjs spikes/test-adapter/live.ts
//
// Expects the live endpoint env (set before running):
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1
//   THIHY_LIVE_KEY=ag_local_...
//   THIHY_LIVE_MODEL=thihy

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ThihyLlmAdapter } from '../../src/main/dsh/llm-adapter';
import type { ResolvedEndpoint } from '../../src/main/dsh/client';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const BASE = process.env.THIEHY_LIVE_BASE ?? process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIEHY_LIVE_KEY ?? process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIEHY_LIVE_MODEL ?? process.env.THIHY_LIVE_MODEL ?? 'thihy';

const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };

const log = (m: string) => console.log(`[live] ${m}`);

async function main() {
  const { boot } = await import('@deepseek-ai/dsh-app-boot');
  log(`boot() cfg=${cfg} base=${BASE} model=${MODEL}`);
  const ctx = await boot('thihy-live-test', cfg, undefined, undefined, bareBase);
  log('boot ok');

  const llm = ctx.get('llm') as { registerAdapter(providers: string[], adapter: unknown): () => void };
  llm.registerAdapter(['thihy'], new ThihyLlmAdapter({ getEndpoint: () => endpoint }));
  log('real ThihyLlmAdapter registered');

  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const tools = ctx.get('tools') as { register(def: unknown): () => void };
  tools.register(defineTool({
    name: 'echo',
    description: 'Echo back the given text verbatim. Use when the user asks you to echo something.',
    parameters: { text: { type: 'string', required: true, description: 'the text to echo' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'echo' }] },
    async execute(args: { text: string }) {
      log(`tool:echo execute ${JSON.stringify(args)}`);
      return args.text;
    },
  }));
  log('echo tool registered');

  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const agents = ctx.get('agents') as {
    create(o: unknown): Promise<{ agent: { followup(m: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }>;
  };
  const handle = await agents.create({
    sessionId: SessionId('live-1'),
    agentOptions: { provider: 'thihy', model: MODEL },
  });
  log('agent created');

  let fullText = '';
  let tokenCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  const callNames = new Map<string, string>();
  const off = ctx.on('session/event', (_session: unknown, event: { type: string; data?: unknown }) => {
    const t = event?.type;
    if (t === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: { type?: string; text?: string } } | undefined)?.chunk;
      if (chunk?.type === 'text-delta' && chunk.text) {
        fullText += chunk.text;
        tokenCount++;
      }
    } else if (t === 'tool/call') {
      const d = event.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
      if (d?.callId != null && d.name) callNames.set(String(d.callId), d.name);
      toolCallCount++;
      log(`tool/call name=${d?.name} args=${d?.arguments}`);
    } else if (t === 'tool/result') {
      const d = event.data as { message?: { source?: { callId?: unknown }; content?: Array<{ isError?: boolean; content?: unknown[] }> } } | undefined;
      const block = d?.message?.content?.[0];
      const name = d?.message?.source?.callId != null ? (callNames.get(String(d.message!.source!.callId)) ?? '') : '';
      toolResultCount++;
      log(`tool/result name=${name} ok=${!block?.isError}`);
    } else if (t === 'assistant/message' || t === 'turn/end') {
      log(`event: ${t}`);
    }
  });

  const userMsg = createUserMessage({
    content: [{ type: 'text', text: "Use the echo tool to echo the text 'hello world'. After it returns, reply in one short sentence that you are done." }],
    source: { kind: 'user' },
  });
  log('followup...');
  handle.agent.followup(userMsg);
  log('whenIdle... (waiting for live model + agent loop)');
  await handle.agent.whenIdle();
  off();
  log(`whenIdle resolved. tokens=${tokenCount} toolCalls=${toolCallCount} toolResults=${toolResultCount}`);
  log(`final text: ${JSON.stringify(fullText).slice(0, 200)}`);

  const pass = toolCallCount >= 1 && toolResultCount >= 1 && tokenCount >= 1;
  await handle.dispose();
  await ctx.fiber?.dispose?.();

  if (pass) {
    log('PASS: live model called a tool, tool executed, result fed back, final text streamed');
    process.exitCode = 0;
  } else {
    log(`FAIL: expected >=1 toolCall(=${toolCallCount}) + >=1 toolResult(=${toolResultCount}) + >=1 token(=${tokenCount})`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('[live] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});
