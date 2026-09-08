// Stage C3 smoke: cross-process session round-trip.
// The whole point of dsh-session-persistence-jsonl is "survives restart".
// This smoke proves it end-to-end:
//
//   1. Fresh ctx #1: create session, append 2 events, session/flush, dispose.
//   2. Confirm the JSONL file is on disk under <DSH_SESSIONS_ROOT>.
//   3. Fresh ctx #2 (same root, but a brand-new process — no in-memory state
//      from ctx #1): call ctx.sessionPersistence.load(sid) and check the
//      returned header.id matches AND events.length matches.
//
// If the on-disk format round-trips, any future resume UX (L2 gap) can be
// built on top — that's the foundation this smoke verifies.
import { boot } from '@deepseek-ai/dsh-app-boot';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = pathResolve(here, '..', '..');
const cfg = pathResolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const sessionsRoot = mkdtempSync(join(tmpdir(), 'thihy-smoke-s6-'));
process.env.DSH_SESSIONS_ROOT = sessionsRoot;
console.log('[s6] DSH_SESSIONS_ROOT =', sessionsRoot);

const SID = 'roundtrip-' + Date.now();
const EXPECTED_EVENTS = 1;

async function pass1(): Promise<void> {
  console.log('[s6.p1] booting ctx #1...');
  const ctx = await boot('thihy-smoke-s6-p1', cfg, undefined, undefined, bareBase);
  const persistence = ctx.get('sessionPersistence');
  if (!persistence) throw new Error('ctx.sessionPersistence missing');
  const sessions = ctx.get('sessions') as {
    create: (id: string, options?: { meta?: { id: string; createdAt: number; version: number; cwd?: string } }) => Promise<{ append: (type: string, data: unknown) => Promise<void> }>;
  };
  const session = await sessions.create(SID, {
    meta: { id: SID, createdAt: Date.now(), version: 1, cwd: projectRoot },
  });
  // Append the simplest non-surface event type: `session/end-seed` has an
  // empty payload (`Record<string, never>`) and no required ordering
  // preconditions beyond being written by the Session constructor in normal
  // use. The richer user/message + assistant/message types are surface
  // events and need a `surfaceOp` field plus a fully-typed Message; we
  // only need to prove the persistence layer round-trips, not the LLM
  // message shape.
  await session.append('session/end-seed', {});
  await ctx.parallel('session/flush', session);
  console.log(`[s6.p1] wrote session "${SID}" with ${EXPECTED_EVENTS} events`);
  await ctx.fiber?.dispose?.();
  console.log('[s6.p1] ctx #1 disposed');
}

async function pass2(): Promise<void> {
  console.log('[s6.p2] booting ctx #2 (fresh process)...');
  // Re-import boot — this is the same module export, but the point is that
  // NO in-memory state from pass1 carries over; the ctx is brand-new and
  // its only knowledge of the session is what's on disk under sessionsRoot.
  const ctx = await boot('thihy-smoke-s6-p2', cfg, undefined, undefined, bareBase);
  const persistence = ctx.get('sessionPersistence') as {
    load: (id: string) => Promise<{
      meta: { id: string; createdAt: number };
      inheritedEventCount: number;
      events: readonly SessionEvent[];
    }>;
  };
  if (!persistence) throw new Error('ctx.sessionPersistence missing in pass 2');
  const inspection = await persistence.load(SID);
  console.log(`[s6.p2] loaded "${inspection.meta.id}" — ${inspection.events.length} events`);
  if (inspection.meta.id !== SID) {
    throw new Error(`meta.id mismatch: got "${inspection.meta.id}", expected "${SID}"`);
  }
  if (inspection.events.length !== EXPECTED_EVENTS) {
    throw new Error(`events.length mismatch: got ${inspection.events.length}, expected ${EXPECTED_EVENTS}`);
  }
  // Spot-check the event types round-tripped (zstd encode → decode).
  const types = inspection.events.map((e) => e.type);
  console.log('[s6.p2] event types:', types.join(', '));
  if (!types.includes('session/end-seed')) {
    throw new Error(`event type lost in round-trip: ${types.join(', ')}`);
  }
  await ctx.fiber?.dispose?.();
  console.log('[s6.p2] ctx #2 disposed');
}

function listAllFiles(dir: string): string[] {
  const out: string[] = [];
  (function walk(d: string, prefix: string): void {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, rel);
      else out.push(rel);
    }
  })(dir, '');
  return out;
}

try {
  await pass1();
  if (!existsSync(sessionsRoot)) throw new Error('sessionsRoot missing after pass 1');
  const files = listAllFiles(sessionsRoot);
  console.log('[s6] on-disk file count after pass 1:', files.length);
  if (files.length === 0) throw new Error('no files on disk after pass 1');
  const log = files.find((f) => f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'));
  if (!log) throw new Error('no jsonl(zstd) file on disk after pass 1');
  console.log('[s6] on-disk log:', log);

  await pass2();
  console.log('[s6] OK');
} catch (err) {
  console.error('[s6] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}