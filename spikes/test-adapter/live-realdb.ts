// LIVE test of the todo.list normalize fix + Chinese persona, without a real
// SQLite DB (better-sqlite3 is built for Electron's Node 20 ABI, not system
// Node 22). The mock repo.list MIMICS the real repo's array-only contract: it
// THROWS if filter.status is a non-array (exactly the bug the model triggered
// by passing status:'all'). So a passing run proves the tool's execute now
// normalizes the model's string status into an array (or omits it for 'all')
// BEFORE repo.list is called.
//
// Also verifies: the AI sees the COMPLETE canned list (answer names both
// canned titles) and answers in Chinese (persona reached the model).
//
// Run:
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1 THIHY_LIVE_KEY=ag_local_... \
//   THIHY_LIVE_MODEL=thihy npx tsx --import ./spikes/test-adapter/register.mjs \
//   spikes/test-adapter/live-realdb.ts

import { app } from 'electron';
import { getDshRuntime } from '../../src/main/dsh/dsh-runtime';
import type { ResolvedEndpoint } from '../../src/main/dsh/endpoints';
import type { TurnEvent } from '../../src/main/dsh/dsh-runtime';
import type { Todo, TodoFilter } from '../../src/shared/todo-types';

const BASE = process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIHY_LIVE_MODEL ?? 'thihy';
const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };

const log = (m: string) => console.log(`[live-db] ${m}`);

// Two canned todos the model should surface in its answer.
const CANNED: Todo[] = [
  { id: 'c1', title: '写周报', status: 'doing', priority: 'medium', project: null, dueAt: null, bodyPath: '', createdAt: 1, updatedAt: 1, doneAt: null, tags: [], attachmentIds: [], drawingIds: [], groupId: null },
  { id: 'c2', title: '买牛奶', status: 'inbox', priority: 'low', project: null, dueAt: null, bodyPath: '', createdAt: 2, updatedAt: 2, doneAt: null, tags: [], attachmentIds: [], drawingIds: [], groupId: null },
];

// Mock repo that enforces the REAL repo's contract: status must be an array
// (or undefined). A bare string like 'all' would make the real repo throw on
// `.map` — so this throws too, proving the normalize fix is exercised.
const mockRepo = {
  list: (filter: TodoFilter = {}) => {
    if (filter.status !== undefined && !Array.isArray(filter.status)) {
      throw new Error(`mockRepo.list: status must be array, got ${typeof filter.status}=${String(filter.status)}`);
    }
    log(`mockRepo.list called with filter=${JSON.stringify(filter)} → returning ${CANNED.length} todos`);
    return CANNED;
  },
  get: async () => null,
  create: async () => ({ ...CANNED[0] }),
  update: async () => ({}),
  delete: async () => undefined,
  search: async () => [],
  stats: async () => ({ byStatus: {}, recent: [] }),
};
const mockMd = { readBody: async () => '', writeBody: async () => ({}), history: async () => [], filePathFor: () => '/tmp/mock.md', restoreVersion: () => undefined };
const mockDrawings = { list: async () => [], read: async () => null, save: async () => ({ id: 'mock-d' }), delete: () => undefined };

async function main() {
  log(`getDshRuntime() base=${BASE} model=${MODEL} (app root=${app.getAppPath()})`);
  const runtime = await getDshRuntime({
    getEndpoint: () => endpoint,
    repo: mockRepo as never,
    md: mockMd as never,
    drawings: mockDrawings as never,
  });
  if (!runtime) { log('FAIL: runtime is null (boot failed)'); process.exit(1); }
  log('runtime booted');

  let tokens = 0;
  let listCalls = 0;
  let answer = '';

  const res = await runtime.runTurn({
    prompt: '列出我所有的 todo，用中文回答。',
    invocationId: 'live-db-1',
    onEvent: (e: TurnEvent) => {
      switch (e.type) {
        case 'token': tokens++; answer += e.text; break;
        case 'toolCall':
          if (e.name === 'todo.list') listCalls++;
          log(`toolCall name=${e.name} args=${JSON.stringify(e.args)}`);
          break;
        case 'toolResult': log(`toolResult name=${e.name} ok=${e.ok}`); break;
        case 'done': log('done'); break;
        case 'error': log(`error ${e.message}`); break;
      }
    },
  });

  log(`answer=${JSON.stringify(answer)}`);
  log(`tokens=${tokens} listCalls=${listCalls}`);

  await runtime.dispose();

  const sawAllTitles = CANNED.every((t) => answer.includes(t.title));
  const hasCJK = /[一-鿿]/.test(answer);
  const pass = listCalls >= 1 && sawAllTitles && hasCJK && tokens >= 1;
  log(pass
    ? `PASS: todo.list normalize (no throw on string status) + AI listed all ${CANNED.length} todos + Chinese`
    : `FAIL: listCalls=${listCalls} sawAllTitles=${sawAllTitles} hasCJK=${hasCJK} tokens=${tokens}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[live-db] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});
