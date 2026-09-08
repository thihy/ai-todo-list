// Boot test under Electron's REAL bundled Node (Node 20.18, no zstd).
// Run from project root: npx electron spikes/test-adapter/boot-electron.mjs
// Proves the production DSH tree boots on Electron's Node without the zstd
// failure (persistence removed from cordis.yml). Exits 0 on success.

import { app } from 'electron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

async function main() {
  const { boot } = await import('@deepseek-ai/dsh-app-boot');
  const ctx = await boot('thihy-electron-test', cfg, undefined, undefined, bareBase);
  const llm = ctx.get('llm');
  const tools = ctx.get('tools');
  const agents = ctx.get('agents');
  const ok = !!(llm && tools && agents);
  // eslint-disable-next-line no-console
  console.log(`[boot-electron] node=${process.versions.node} electron=${process.versions.electron}`);
  // eslint-disable-next-line no-console
  console.log(`[boot-electron] llm=${!!llm} tools=${!!tools} agents=${!!agents} agentLoop=${!!ctx.get('agentLoop')}`);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.error('[boot-electron] FAIL: a required service is absent');
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.log('[boot-electron] PASS: DSH booted under Electron Node');
  await ctx.fiber?.dispose?.();
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[boot-electron] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});
