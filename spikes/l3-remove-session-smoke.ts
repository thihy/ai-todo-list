// L3-G smoke: verify runtime.removeSession(id) deletes the JSONL log.
//
// Three assertions:
//
//   1. After a runTurn on a conversationId, the JSONL file exists under
//      <DSH_SESSIONS_ROOT>/<project>/<id>/session.jsonl[.zstd].
//
//   2. Calling runtime.removeSession(id) returns { removed: true } and the
//      JSONL file is gone from disk.
//
//   3. removeSession on a non-existent id is a safe no-op
//      ({ removed: false }, no throw).
//
// Run:
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1 THIHY_LIVE_KEY=ag_local_... \
//   THIHY_LIVE_MODEL=thihy npx tsx --import ./spikes/test-adapter/register.mjs \
//   spikes/l3-remove-session-smoke.ts

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDshRuntime } from '../src/main/dsh/dsh-runtime';
import type { ResolvedEndpoint } from '../src/main/dsh/endpoints';
import type { TurnEvent } from '../src/main/dsh/dsh-runtime';

const BASE = process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIHY_LIVE_MODEL ?? 'thihy';

if (!KEY) {
  console.log('[l3-remove] SKIP: THIHY_LIVE_KEY not set');
  process.exit(0);
}

const sessionsRoot = mkdtempSync(join(tmpdir(), 'thihy-l3g-'));
process.env.DSH_SESSIONS_ROOT = sessionsRoot;
console.log(`[l3-remove] DSH_SESSIONS_ROOT=${sessionsRoot}`);

const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };
const log = (m: string) => console.log(`[l3-remove] ${m}`);

const mockRepo = {
  list: () => [],
  get: () => null,
  create: () => ({}),
  update: () => ({}),
  delete: () => undefined,
  search: () => [],
  stats: () => ({ byStatus: {}, recent: [] }),
};
const mockMd = {
  readBody: () => Promise.resolve(''),
  writeBody: () => Promise.resolve({ version: 1, updatedAt: Date.now() }),
  history: () => Promise.resolve([]),
  filePathFor: () => '/tmp/mock.md',
  restoreVersion: () => undefined,
};
const mockDrawings = {
  list: () => Promise.resolve([]),
  read: () => Promise.resolve(null),
  save: () => Promise.resolve({ id: 'mock-d' }),
  delete: () => undefined,
};

/** Walk <root>/<project>/<id>/ — return the first session dir found for the given id. */
function findSessionDir(root: string, id: string): string | null {
  if (!existsSync(root)) return null;
  for (const p of readdirSync(root, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    const candidate = join(root, p.name, id);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  log(`base=${BASE} model=${MODEL}`);
  const runtime = await getDshRuntime({
    getEndpoint: () => endpoint,
    repo: mockRepo as never,
    md: mockMd as never,
    drawings: mockDrawings as never,
  });
  if (!runtime) {
    log('FAIL: runtime is null');
    process.exit(1);
  }
  log('runtime booted');

  // ---------- 1. runTurn produces a JSONL file on disk ----------
  const convId = `l3g-${Date.now()}`;
  await runtime.runTurn({
    prompt: '只回答一个水果的名字，不要任何解释。',
    conversationId: convId,
    invocationId: `${convId}-inv`,
    onEvent: (_e: TurnEvent) => { /* drop */ },
  });

  const dirBefore = findSessionDir(sessionsRoot, convId);
  if (!dirBefore) {
    log(`FAIL: no session dir under ${sessionsRoot} for ${convId}`);
    process.exit(1);
  }
  log(`session dir before remove: ${dirBefore}`);

  // ---------- 2. removeSession returns { removed: true } and clears the dir ----------
  const res = await runtime.removeSession(convId);
  log(`removeSession result: ${JSON.stringify(res)}`);
  if (!res.removed) { log('FAIL: removeSession returned removed=false'); process.exit(1); }
  const dirAfter = findSessionDir(sessionsRoot, convId);
  if (dirAfter) { log(`FAIL: session dir still exists after remove: ${dirAfter}`); process.exit(1); }
  log('session dir removed ✓');

  // ---------- 3. removeSession on unknown id is a safe no-op ----------
  const unknownId = `l3g-never-existed-${Date.now()}`;
  const res2 = await runtime.removeSession(unknownId);
  log(`removeSession(unknown) result: ${JSON.stringify(res2)}`);
  if (res2.removed) { log('FAIL: removeSession on unknown id returned removed=true'); process.exit(1); }

  await runtime.dispose();
  try { rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* noop */ }
  log(`PASS: removeSession deletes JSONL; unknown id is a no-op`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[l3-remove] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});