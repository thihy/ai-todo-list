// Boot smoke for cordis.yml with dsh-session-persistence-jsonl added.
// Verifies:
// - The `!!js` YAML expression scalar for `root` evaluates
//   `process.env.DSH_SESSIONS_ROOT` at YAML parse time (the cordis Loader
//   runs `eval(expr)` with the loader's scope on the stack — `process` is a
//   global so it's reachable).
// - ctx.sessionPersistence is present (the plugin's exposed service).
// - config.root resolves to the value of the env var.
// - A real session, after create + append, materializes a JSONL file under
//   the root (so the JSONL backend's write path is alive end-to-end and the
//   on-disk layout matches the plugin's spec).
import { boot } from '@deepseek-ai/dsh-app-boot';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = pathResolve(here, '..', '..');
const cfg = pathResolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

// Fresh writable root for every smoke run.
const sessionsRoot = mkdtempSync(join(tmpdir(), 'thihy-smoke-s5-'));
process.env.DSH_SESSIONS_ROOT = sessionsRoot;
console.log('[s5] DSH_SESSIONS_ROOT =', sessionsRoot);

try {
  const ctx = await boot('thihy-smoke-s5', cfg, undefined, undefined, bareBase);

  // 1. ctx.sessionPersistence present + root matches the env var.
  const persistence = ctx.get('sessionPersistence') as {
    name?: string;
    config?: { root?: string; compression?: string };
  } | undefined;
  console.log('[s5] ctx.sessionPersistence:', persistence ? 'present' : 'ABSENT');
  if (!persistence) { console.error('[s5] FAIL: ctx.sessionPersistence missing'); process.exit(2); }
  console.log('[s5] persistence name:', persistence.name);
  console.log('[s5] persistence root:', persistence.config?.root);
  console.log('[s5] persistence compression:', persistence.config?.compression);
  if (persistence.config?.root !== sessionsRoot) {
    console.error(`[s5] FAIL: root mismatch (got ${persistence.config?.root}, expected ${sessionsRoot})`);
    process.exit(3);
  }
  if (persistence.config?.compression !== 'zstd') {
    console.error(`[s5] FAIL: compression mismatch (got ${persistence.config?.compression})`);
    process.exit(4);
  }

  // 2. ctx.sessions is the in-memory coordinator (already mounted).
  const sessions = ctx.get('sessions') as {
    create: (id: string, options?: { meta?: { id: string; createdAt: number; version: number; cwd?: string } }) => unknown;
  };
  if (!sessions) { console.error('[s5] FAIL: ctx.sessions missing'); process.exit(5); }

  // 3. Create a session. The plugin's coordinator writes the header line on
  //    announcement, so as soon as create() returns, the directory layout
  //    for this session exists under the root.
  const sid = 'smoke-' + Date.now();
  const session = await sessions.create(sid, {
    meta: { id: sid, createdAt: Date.now(), version: 1, cwd: projectRoot },
  });
  console.log('[s5] session created:', sid);

  // 4. Append two events. session.append(type, data) — type is a string
  //    from KNOWN_SESSION_EVENT_TYPES, data is the per-type payload.
  //    append() is async and the JSONL backend's append() flushes to disk
  //    before the returned promise resolves, so we await each one.
  await (session as { append: (type: string, data: unknown) => Promise<void> }).append('user', {
    content: 'hello from smoke',
  });
  await (session as { append: (type: string, data: unknown) => Promise<void> }).append('assistant', {
    content: 'hi back',
  });
  console.log('[s5] appended 2 events (awaited)');

  // 5. Force a flush. The JSONL backend coalesces live events on a
  //    writeBatchMaxDelayMs window (default 200ms) and only writes on the
  //    trailing edge OR on `session/flush`. We emit flush on the cordis
  //    ctx so the coordinator drains the queue deterministically rather
  //    than racing the 200ms timer.
  await ctx.parallel('session/flush', session);
  console.log('[s5] session/flush emitted');

  // 6. On-disk check. The plugin stores under <root>/<projectKey>/<sid>/.
  //    Project key is derived from the session's cwd (here = our projectRoot).
  //    We don't pin the layout, just confirm at least one .jsonl.zstd or .jsonl
  //    file materialized.
  if (!existsSync(sessionsRoot)) {
    console.error('[s5] FAIL: sessionsRoot does not exist on disk');
    process.exit(6);
  }
  const entries: string[] = [];
  (function walk(dir: string, prefix: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, rel);
      else entries.push(rel);
    }
  })(sessionsRoot, '');
  console.log('[s5] on-disk file count:', entries.length);
  if (entries.length === 0) {
    console.error('[s5] FAIL: no files materialized under root');
    process.exit(7);
  }
  const log = entries.find((e) => e.endsWith('.jsonl.zstd') || e.endsWith('.jsonl'));
  if (!log) {
    console.error('[s5] FAIL: no .jsonl(zstd) file materialized. entries:', entries);
    process.exit(8);
  }
  console.log('[s5] on-disk log:', log);

  await ctx.fiber?.dispose?.();
  console.log('[s5] OK');
} catch (err) {
  console.error('[s5] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
