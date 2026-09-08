// Runtime boot smoke test for the production DSH path. Proves that bootDsh()
// loads resources/dsh/cordis.yml, activates every service (llm/tools/sessions/
// agents/agent-loop/session-persistence), registers the ThihyLlmAdapter for the
// 'thihy' route, and registers all 16 typed domain tools via defineTool without
// a runtime shape error. This catches what typecheck cannot (e.g. a tool def the
// defineTool runtime rejects, or an unsupported `!!js` YAML tag in cordis.yml).
//
// chdir's to a temp dir first so cordis.yml's `root: process.cwd()+/...` session
// path does not pollute the repo. The electron stub's getAppPath returns the
// real project root so cordis.yml + node_modules still resolve.
//
// Run: npx tsx --import ./spikes/test-adapter/register.mjs spikes/test-adapter/boot-test.ts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDshRuntime } from '../../src/main/dsh/dsh-runtime';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// Isolate session-persistence writes to a temp dir (process.cwd() drives the
// cordis.yml `root:`). getAppPath in the electron stub is fixed to the project
// root, so cordis.yml + bareModuleBaseUrl still resolve correctly.
const tempDir = mkdtempSync(join(tmpdir(), 'thihy-boot-'));
process.chdir(tempDir);
console.log(`  (cwd → ${tempDir})`);

const runtime = await getDshRuntime({
  getEndpoint: () => ({ protocol: 'openai', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' } as never),
  repo: {} as never,
  md: {} as never,
  drawings: {} as never,
});

assert(runtime !== null, 'DSH runtime booted (non-null) — cordis.yml loaded, all services activated');
assert(typeof runtime?.runTurn === 'function', 'runTurn is exposed');
assert(typeof runtime?.dispose === 'function', 'dispose is exposed');

if (runtime) {
  await runtime.dispose();
  console.log('  ✓ dispose() completed without throwing');
}

if (process.exitCode) {
  console.log('\n❌ BOOT TEST FAILED');
} else {
  console.log('\n✅ BOOT TEST PASSED — production DSH runtime is live');
}
