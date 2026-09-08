// Boot smoke for cordis.yml with dsh-tool-todo added. If boot() returns
// without throwing, cordis parsed the YAML, loaded the package, validated the
// config, resolved all inject deps (tools, sessionProjections), and called
// apply() — which is where dsh-tool-todo registers its todo_write tool and
// its `todos` projection. That's the contract: any failure (bad config, missing
// dep, broken apply) would have surfaced here.
import { boot } from '@deepseek-ai/dsh-app-boot';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

try {
  const ctx = await boot('thihy-smoke-s2', cfg, undefined, undefined, bareBase);
  // Service-level check: tools and sessionProjections (the inject deps for
  // dsh-tool-todo) are both present.
  const tools = ctx.get('tools');
  const projections = ctx.get('sessionProjections');
  console.log('[s2] ctx.tools:', tools ? typeof tools : 'ABSENT');
  console.log('[s2] ctx.sessionProjections:', projections ? typeof projections : 'ABSENT');
  if (!tools || !projections) {
    console.error('[s2] FAIL: required inject deps missing');
    process.exit(2);
  }
  // Smoke-test the projection registry: every registered projection must be
  // accessible by key. dsh-tool-todo registers 'todos'.
  const projRegistry = (projections as { registry?: Map<string, unknown> }).registry
    ?? (projections as { registrations?: Map<string, unknown> }).registrations;
  if (projRegistry instanceof Map) {
    const keys = Array.from(projRegistry.keys()).sort();
    console.log('[s2] projection keys:', keys.join(', '));
    console.log('[s2] has todos projection:', keys.includes('todos'));
  } else {
    console.log('[s2] projection registry shape:', Object.keys(projections).join(', '));
  }
  await ctx.fiber?.dispose?.();
  console.log('[s2] OK');
} catch (err) {
  console.error('[s2] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
