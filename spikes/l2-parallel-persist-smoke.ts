// L2-E smoke: end-to-end verification of the multi-conversation architecture.
//
// Verifies three properties of the L2 runtime refactor:
//
//   1. Two conversations can run CONCURRENTLY on independent agents (the
//      Map<conversationId, Entry> cache is real, not a singleton).
//   2. Events for one conversation's session do NOT leak into the other's
//      onEvent stream (the per-entry session/event filter actually filters).
//   3. Each conversation's history lands in its own JSONL file under
//      <DSH_SESSIONS_ROOT>, and loadHistory({conversationId}) decodes only
//      that file.
//
// We use distinct prompts whose correct answers are easy to distinguish
// (animal vs fruit) so a leak between conversations is detectable: if
// filtering breaks, convA's answer would include the animal word or
// convB's answer would include the fruit word.
//
// Run:
//   THIHY_LIVE_BASE=http://127.0.0.1:9999/v1 THIHY_LIVE_KEY=ag_local_... \
//   THIHY_LIVE_MODEL=thihy npx tsx --import ./spikes/test-adapter/register.mjs \
//   spikes/l2-parallel-persist-smoke.ts
//
// Skips gracefully if THIHY_LIVE_KEY is empty (no live endpoint configured).

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDshRuntime } from '../src/main/dsh/dsh-runtime';
import type { ResolvedEndpoint } from '../src/main/dsh/client';
import type { TurnEvent } from '../src/main/dsh/dsh-runtime';

const BASE = process.env.THIHY_LIVE_BASE ?? 'http://127.0.0.1:9999/v1';
const KEY = process.env.THIHY_LIVE_KEY ?? '';
const MODEL = process.env.THIHY_LIVE_MODEL ?? 'thihy';

if (!KEY) {
  console.log('[l2-parallel] SKIP: THIHY_LIVE_KEY not set; live creds required for parallel smoke');
  process.exit(0);
}

// Each conversation writes to its own JSONL file under DSH_SESSIONS_ROOT.
// Use a fresh tmp dir so we don't disturb any real persisted sessions.
const sessionsRoot = mkdtempSync(join(tmpdir(), 'thihy-l2e-'));
process.env.DSH_SESSIONS_ROOT = sessionsRoot;
console.log(`[l2-parallel] DSH_SESSIONS_ROOT=${sessionsRoot}`);

const endpoint: ResolvedEndpoint = { protocol: 'openai', baseUrl: BASE, apiKey: KEY, model: MODEL };

const log = (m: string) => console.log(`[l2-parallel] ${m}`);

// Minimal mock deps — the model isn't expected to call these (prompts are
// pure-text answers), but the runtime boot still requires they exist.
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

interface Captured {
  tokens: string[];
  reasoning: string[];
  toolCalls: string[];
  fullText: string;
  done: boolean;
  err?: string;
}

function capture(): Captured {
  return { tokens: [], reasoning: [], toolCalls: [], fullText: '', done: false };
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
    log('FAIL: runtime is null (DSH boot failed — check resources/dsh/cordis.yml)');
    process.exit(1);
  }
  log('runtime booted');

  // Distinct prompts → distinct expected answers. A leak between the two
  // conversations would manifest as animal words appearing in conv-fruit's
  // tokens, or vice versa.
  const convFruit = `l2e-fruit-${Date.now()}`;
  const convAnimal = `l2e-animal-${Date.now()}`;
  const invFruit = `${convFruit}-inv`;
  const invAnimal = `${convAnimal}-inv`;

  const capFruit = capture();
  const capAnimal = capture();

  // Fire BOTH conversations in parallel — proves the runtime supports
  // concurrent turns on different conversationIds, not just sequential.
  const t0 = Date.now();
  const [resFruit, resAnimal] = await Promise.all([
    runtime.runTurn({
      prompt: '只回答一个水果的名字，不要任何解释，不要任何标点。',
      conversationId: convFruit,
      invocationId: invFruit,
      onEvent: (e: TurnEvent) => recordEvent(e, capFruit, 'fruit'),
    }),
    runtime.runTurn({
      prompt: '只回答一个动物的名字，不要任何解释，不要任何标点。',
      conversationId: convAnimal,
      invocationId: invAnimal,
      onEvent: (e: TurnEvent) => recordEvent(e, capAnimal, 'animal'),
    }),
  ]);
  log(`parallel turns took ${Date.now() - t0}ms`);

  // --- Assertions ---

  // 1. Both runs succeeded.
  if (!resFruit.content) { log(`FAIL: fruit turn produced no content`); process.exit(1); }
  if (!resAnimal.content) { log(`FAIL: animal turn produced no content`); process.exit(1); }

  // 2. Each conversation received at least one token (the model actually responded).
  if (capFruit.tokens.length === 0) { log('FAIL: fruit conversation received 0 tokens'); process.exit(1); }
  if (capAnimal.tokens.length === 0) { log('FAIL: animal conversation received 0 tokens'); process.exit(1); }

  // 3. NO cross-contamination: the fruit conversation's tokens must not
  //    include any animal-name substring, and vice versa. We use a lenient
  //    substring check on the accumulated fullText because the model may
  //    emit reasoning first or include minor formatting.
  const fruitText = capFruit.fullText.toLowerCase();
  const animalText = capAnimal.fullText.toLowerCase();
  const ANIMAL_WORDS = ['猫', '狗', '马', '牛', '羊', '猪', '鸡', '鸭', '鱼', '虎', '狼', '熊', '兔', '象', '鼠', 'cat', 'dog', 'horse', 'tiger'];
  const FRUIT_WORDS = ['苹果', '香蕉', '橘子', '葡萄', '西瓜', '草莓', '梨', '桃', 'apple', 'banana', 'orange', 'grape'];
  const fruitLeakedAnimal = ANIMAL_WORDS.some((w) => fruitText.includes(w.toLowerCase()));
  const animalLeakedFruit = FRUIT_WORDS.some((w) => animalText.includes(w.toLowerCase()));
  if (fruitLeakedAnimal) {
    log(`FAIL: fruit conversation leaked animal words: tokens=${JSON.stringify(capFruit.tokens)}`);
    process.exit(1);
  }
  if (animalLeakedFruit) {
    log(`FAIL: animal conversation leaked fruit words: tokens=${JSON.stringify(capAnimal.tokens)}`);
    process.exit(1);
  }
  log(`fruit text=${JSON.stringify(capFruit.fullText)} | animal text=${JSON.stringify(capAnimal.fullText)}`);

  // 4. JSONL persistence: both conversation ids should have a session file
  //    under <DSH_SESSIONS_ROOT>/<project>/<id>/session.jsonl[.zstd]. Walk
  //    the dir to find them rather than hard-coding the project path.
  const found = findSessionFiles(sessionsRoot);
  log(`session files on disk: ${JSON.stringify(found)}`);
  const hasFruit = found.some((p) => p.includes(convFruit));
  const hasAnimal = found.some((p) => p.includes(convAnimal));
  if (!hasFruit) { log(`FAIL: no session file found for ${convFruit}`); process.exit(1); }
  if (!hasAnimal) { log(`FAIL: no session file found for ${convAnimal}`); process.exit(1); }

  // 5. loadHistory returns the conversation's own turns and NOT the other's.
  //    We check the user prompt is present in each, which is the most
  //    deterministic turn (the model's response text varies).
  const histFruit = await runtime.loadHistory({ conversationId: convFruit });
  const histAnimal = await runtime.loadHistory({ conversationId: convAnimal });
  log(`history turns — fruit: ${histFruit.length}, animal: ${histAnimal.length}`);
  if (histFruit.length === 0) { log('FAIL: loadHistory(fruit) returned 0 turns'); process.exit(1); }
  if (histAnimal.length === 0) { log('FAIL: loadHistory(animal) returned 0 turns'); process.exit(1); }
  const fruitHasUser = histFruit.some((t) => t.type === 'user' && (t.text ?? '').includes('水果'));
  const animalHasUser = histAnimal.some((t) => t.type === 'user' && (t.text ?? '').includes('动物'));
  if (!fruitHasUser) { log(`FAIL: fruit history missing user turn with 水果; turns=${JSON.stringify(histFruit)}`); process.exit(1); }
  if (!animalHasUser) { log(`FAIL: animal history missing user turn with 动物; turns=${JSON.stringify(histAnimal)}`); process.exit(1); }

  // 6. Cross-contamination in history: each history must NOT contain the
  //    OTHER conversation's user prompt. This catches a persistence-layer
  //    bug where two sessions share a file.
  const fruitHasOtherPrompt = histFruit.some((t) => t.type === 'user' && (t.text ?? '').includes('动物'));
  const animalHasOtherPrompt = histAnimal.some((t) => t.type === 'user' && (t.text ?? '').includes('水果'));
  if (fruitHasOtherPrompt) { log('FAIL: fruit history contains animal prompt'); process.exit(1); }
  if (animalHasOtherPrompt) { log('FAIL: animal history contains fruit prompt'); process.exit(1); }

  await runtime.dispose();

  // Cleanup tmp dir.
  try { rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* noop */ }
  log(`PASS: parallel turns, no event cross-contamination, independent JSONL files, independent history loads`);
  process.exit(0);
}

function recordEvent(e: TurnEvent, cap: Captured, label: string): void {
  switch (e.type) {
    case 'token':
      cap.tokens.push(e.text);
      cap.fullText += e.text;
      break;
    case 'reasoning':
      cap.reasoning.push(e.text);
      break;
    case 'toolCall':
      cap.toolCalls.push(e.name);
      break;
    case 'done':
      cap.done = true;
      break;
    case 'error':
      cap.err = e.message;
      break;
  }
  // Lightweight per-event log for debugging cross-contamination.
  if (process.env.L2E_VERBOSE) {
    console.log(`  [${label}] ${e.type}: ${JSON.stringify(e).slice(0, 120)}`);
  }
}

/** Walk the persistence root and return paths of all session files found. */
function findSessionFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  // Project subdir (e.g. <root>/<sanitized-cwd>/<id>/session.jsonl.zstd).
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile() && /session\.jsonl(\.zstd)?$/.test(name.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

main().catch((err) => {
  console.error('[l2-parallel] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});