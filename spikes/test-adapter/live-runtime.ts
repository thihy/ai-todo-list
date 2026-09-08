// LIVE runTurn test through the PRODUCTION getDshRuntime() path (what ai.ask
// calls), against the live gateway. Verifies the full chain the renderer will
// hit: getDshRuntime → bootDsh → ThihyLlmAdapter(live) → agent loop → domain
// tool execution → session/event → runTurn onEvent (token / toolCall+args /
// toolResult+args / done). Mock stores back the 15 domain tools so they execute
// instead of crashing.
//
// Run:
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1 THIHY_LIVE_KEY=ag_local_... \
//   THIHY_LIVE_MODEL=thihy npx tsx --import ./spikes/test-adapter/register.mjs \
//   spikes/test-adapter/live-runtime.ts

import { getDshRuntime } from '../../src/main/dsh/dsh-runtime';
import type { ResolvedEndpoint } from '../../src/main/dsh/client';
import type { TurnEvent } from '../../src/main/dsh/dsh-runtime';

const BASE = process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIHY_LIVE_MODEL ?? 'thihy';
const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };

const log = (m: string) => console.log(`[live-rt] ${m}`);

// Mock stores: return empty/safe values so domain tools execute without a real
// DB / filesystem. The model gets real (empty) data and can answer.
const mockRepo = {
  list: async () => [],
  get: async () => null,
  create: async () => ({ id: 'mock-1', title: 'mock', status: 'todo', priority: 'none', project: null, tags: [], createdAt: Date.now(), updatedAt: Date.now() }),
  update: async () => ({}),
  delete: async () => undefined,
  search: async () => [],
  stats: async () => ({ byStatus: {}, recent: [] }),
};
const mockMd = {
  readBody: async () => '',
  writeBody: async () => ({}),
  history: async () => [],
  filePathFor: () => '/tmp/mock.md',
  restoreVersion: () => undefined,
};
const mockDrawings = {
  list: async () => [],
  read: async () => null,
  save: async () => ({ id: 'mock-d' }),
  delete: () => undefined,
};

async function main() {
  log(`getDshRuntime() base=${BASE} model=${MODEL}`);
  const runtime = await getDshRuntime({
    getEndpoint: () => endpoint,
    repo: mockRepo as never,
    md: mockMd as never,
    drawings: mockDrawings as never,
  });
  if (!runtime) { log('FAIL: runtime is null (boot failed)'); process.exit(1); }
  log('runtime booted');

  let tokens = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let sawArgs = false;
  let fullText = '';

  const res = await runtime.runTurn({
    prompt: '列出我所有的 todo。如果没有，就告诉我列表是空的。',
    invocationId: 'live-rt-1',
    onEvent: (e: TurnEvent) => {
      switch (e.type) {
        case 'token': tokens++; fullText += e.text; break;
        case 'toolCall': toolCalls++; log(`toolCall name=${e.name} args=${JSON.stringify(e.args)}`); break;
        case 'toolResult':
          toolResults++;
          if (e.args !== undefined) sawArgs = true;
          log(`toolResult name=${e.name} ok=${e.ok} args=${JSON.stringify(e.args)?.slice(0, 80)}`);
          break;
        case 'done': log(`done content=${JSON.stringify(e.content).slice(0, 120)}`); break;
        case 'error': log(`error ${e.message}`); break;
      }
    },
  });

  log(`result content=${JSON.stringify(res.content).slice(0, 120)}`);
  log(`tokens=${tokens} toolCalls=${toolCalls} toolResults=${toolResults} sawArgs=${sawArgs}`);

  await runtime.dispose();

  const pass = tokens >= 1 && toolResults === toolCalls && toolCalls >= 1 && sawArgs;
  log(pass ? 'PASS: production runTurn live — tools called, args forwarded, text streamed'
           : `FAIL: tokens=${tokens} toolCalls=${toolCalls} toolResults=${toolResults} sawArgs=${sawArgs}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[live-rt] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});
