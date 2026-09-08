// Stage C4 smoke: verify ctx.sessionPersistence.list() at boot time returns
// all sessions stored under <DSH_SESSIONS_ROOT> across the existing layout.
//
// This is what production dsh-runtime.ts calls on first ai.ask (see the new
// "DSH persistence: N session(s) stored: ..." log line). The smoke
// confirms the same call works without trying to drive the actual runtime.
import { boot } from '@deepseek-ai/dsh-app-boot';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = pathResolve(here, '..', '..');
const cfg = pathResolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const sessionsRoot = mkdtempSync(join(tmpdir(), 'thihy-smoke-s7-'));
process.env.DSH_SESSIONS_ROOT = sessionsRoot;
console.log('[s7] DSH_SESSIONS_ROOT =', sessionsRoot);

const SIDS = ['s7-a-' + Date.now(), 's7-b-' + Date.now(), 's7-c-' + Date.now()];

async function seedSessions(): Promise<void> {
  const ctx = await boot('thihy-smoke-s7-seed', cfg, undefined, undefined, bareBase);
  const sessions = ctx.get('sessions') as {
    create: (id: string, options?: { meta?: { id: string; createdAt: number; version: number; cwd?: string } }) => Promise<{ append: (type: string, data: unknown) => Promise<void> }>;
  };
  for (const sid of SIDS) {
    const session = await sessions.create(sid, {
      meta: { id: sid, createdAt: Date.now(), version: 1, cwd: projectRoot },
    });
    await session.append('session/end-seed', {});
    await ctx.parallel('session/flush', session);
  }
  await ctx.fiber?.dispose?.();
  console.log(`[s7.seed] wrote ${SIDS.length} sessions`);
}

async function passList(): Promise<void> {
  console.log('[s7.list] booting fresh ctx + calling list()...');
  const ctx = await boot('thihy-smoke-s7-list', cfg, undefined, undefined, bareBase);
  const persistence = ctx.get('sessionPersistence') as {
    list: (signal?: AbortSignal) => Promise<Array<{ id: string; createdAt: number }>>;
  };
  if (!persistence?.list) {
    throw new Error('ctx.sessionPersistence.list not available');
  }
  const stored = await persistence.list();
  console.log(`[s7.list] list() returned ${stored.length} sessions:`);
  for (const s of stored) console.log(`  - ${s.id} (createdAt=${s.createdAt})`);
  const storedIds = new Set(stored.map((s) => s.id));
  for (const sid of SIDS) {
    if (!storedIds.has(sid)) {
      throw new Error(`seeded session "${sid}" missing from list() result`);
    }
  }
  await ctx.fiber?.dispose?.();
  console.log('[s7.list] OK — all seeded sessions visible');
}

try {
  await seedSessions();
  if (!existsSync(sessionsRoot)) throw new Error('sessionsRoot missing after seed');
  await passList();
  // Cleanup: tmp dir is auto-pruned by the OS, but for a tidy test bench we
  // can drop it now.
  try { rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* noop */ }
  console.log('[s7] OK');
} catch (err) {
  console.error('[s7] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}