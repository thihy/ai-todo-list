// Probe cordis ctx shape to find how to enumerate loaded plugins.
import { boot } from '@deepseek-ai/dsh-app-boot';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const ctx = await boot('thihy-smoke-s2', cfg, undefined, undefined, bareBase);
const c = ctx as unknown as Record<string, unknown>;
console.log('ctx keys:', Object.keys(c).sort().join(', '));
const reg = c['registry'] as Record<string, unknown> | undefined;
if (reg) console.log('registry keys:', Object.keys(reg).sort().join(', '));
const plug = c['plugin'];
console.log('ctx.plugin type:', typeof plug);
if (typeof plug === 'function') {
  for (const id of ['todo', 'tokenMeter', 'compaction', 'toolResultPruner', 'llm', 'tools', 'agents']) {
    try {
      const v = (plug as (k: string) => unknown)(id);
      console.log('plugin(' + id + '):', v === undefined ? 'absent' : typeof v);
    } catch (e) { console.log('plugin(' + id + ') threw:', String((e as Error).message).slice(0, 80)); }
  }
}
await ctx.fiber?.dispose?.();
console.log('OK');
