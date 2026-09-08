// LIVE end-to-end test for the L4-E cost pipeline:
//   1. Boot DSH + register ThihyLlmAdapter pointing at the live gateway.
//   2. Run a single turn with a non-tool prompt (so the agent finishes after
//      one assistant step — usage fires exactly once).
//   3. Log the assistant/message event's `usage` block to verify the adapter
//      actually reported tokens.
//   4. Then drive the same turn through runTurn-equivalent code so we see
//      the cumulative turnTokensIn/Out the new wiring should produce.
//
// Run: npx tsx --import ./spikes/test-adapter/register.mjs spikes/test-adapter/live-cost.ts
//
// Env:
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1
//   THIHY_LIVE_KEY=ag_local_...
//   THIHY_LIVE_MODEL=thihy

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ThihyLlmAdapter } from '../../src/main/dsh/llm-adapter';
import type { ResolvedEndpoint } from '../../src/main/dsh/endpoints';
import { costForUsage } from '../../src/main/dsh/pricing';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const BASE = process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIHY_LIVE_MODEL ?? 'thihy';

const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };
const log = (m: string) => console.log(`[live-cost] ${m}`);

async function main() {
  const { boot } = await import('@deepseek-ai/dsh-app-boot');
  log(`boot() cfg=${cfg} base=${BASE} model=${MODEL}`);
  const ctx = await boot('thihy-live-cost-test', cfg, undefined, undefined, bareBase);

  const llm = ctx.get('llm') as { registerAdapter(providers: string[], adapter: unknown): () => void };
  llm.registerAdapter(['thihy'], new ThihyLlmAdapter({ getEndpoint: () => endpoint }));

  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const agents = ctx.get('agents') as {
    create(o: unknown): Promise<{ agent: { followup(m: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }>;
  };
  const handle = await agents.create({
    sessionId: SessionId('live-cost-1'),
    agentOptions: { provider: 'thihy', model: MODEL },
  });

  // Track usage the way attachLiveListener does in dsh-runtime.
  let tokensIn = 0;
  let tokensOut = 0;
  let usageEvents = 0;
  const off = ctx.on('session/event', (_session: unknown, event: { type: string; data?: unknown }) => {
    const t = event?.type;
    if (t === 'assistant/message') {
      const d = event.data as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
      if (d?.usage) {
        tokensIn  += d.usage.inputTokens  ?? 0;
        tokensOut += d.usage.outputTokens ?? 0;
        usageEvents++;
        log(`assistant/message usage: in=${d.usage.inputTokens} out=${d.usage.outputTokens}`);
      } else {
        log('assistant/message WITHOUT usage (adapter did not report)');
      }
    }
  });

  const userMsg = createUserMessage({
    content: [{ type: 'text', text: 'Reply with one short sentence telling me the word "ok".' }],
    source: { kind: 'user' },
  });
  log('followup...');
  handle.agent.followup(userMsg);
  await handle.agent.whenIdle();
  off();

  log(`whenIdle resolved. usageEvents=${usageEvents} tokensIn=${tokensIn} tokensOut=${tokensOut}`);
  // Cost under the configured MODEL (whatever the user runs with).
  const cost = costForUsage(MODEL, { inputTokens: tokensIn, outputTokens: tokensOut });
  log(`costForUsage('${MODEL}', ...) = $${cost.toFixed(6)}`);
  // Also compute what the SAME usage would price under deepseek-chat, so the
  // smoke run gives a useful number regardless of the configured model. This
  // is the value the production code would surface if the user switched.
  const dsCost = costForUsage('deepseek-chat', { inputTokens: tokensIn, outputTokens: tokensOut });
  log(`(equivalent under deepseek-chat pricing = $${dsCost.toFixed(6)})`);

  await handle.dispose();
  await ctx.fiber?.dispose?.();

  if (usageEvents === 0) {
    log('FAIL: no usage events were emitted — L4-E wiring will produce 0 cost');
    process.exit(1);
  }
  log('PASS: usage flowed through the session event');
  process.exit(0);
}

main().catch((err) => {
  console.error('[live-cost] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});