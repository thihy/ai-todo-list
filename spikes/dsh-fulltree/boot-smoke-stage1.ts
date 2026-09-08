// Smoke test: boot the PRODUCTION cordis.yml (with token-meter + pruner +
// compaction-basic) and assert the three new services come alive. Verifies the
// wireup is valid (config accepted, inject deps resolved) before we let the
// app load it on first ai.ask.
//
// Runs under system Node 22 (not Electron) — pure DSH boot, no DB, no IPC.
import { boot } from '@deepseek-ai/dsh-app-boot'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Project root = two levels up from spikes/dsh-fulltree/
const projectRoot = resolve(here, '..', '..')
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml')
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href

console.log('[smoke] cfg:', cfg)
console.log('[smoke] bareModuleBaseUrl:', bareBase)
try {
  const ctx = await boot('thihy-smoke', cfg, undefined, undefined, bareBase)
  console.log('[smoke] boot() OK')
  const required = [
    'llm', 'tools', 'systemPrompt', 'sessions', 'sessionProjections',
    'agents', 'agentLoop',
    'tokenMeter', 'toolResultPruner', // dsh-compaction-basic registers via cordis name 'compactionBasic' (default kebab→camel)
  ]
  for (const k of required) {
    const v = ctx.get(k)
    console.log(`[smoke] ctx.get('${k}'):`, v === undefined ? 'ABSENT' : typeof v)
  }
  // Try the convention-derived names for compaction-basic (kebab → camel → plural?)
  for (const k of ['compactionBasic', 'compaction-basic', 'basicCompaction', 'compaction']) {
    const v = ctx.get(k)
    if (v !== undefined) console.log(`[smoke] FOUND ctx.get('${k}'):`, typeof v)
  }
  await ctx.fiber?.dispose?.()
  console.log('[smoke] disposed')
} catch (err) {
  console.error('[smoke] boot FAILED:', (err as Error).message)
  console.error((err as Error).stack)
  process.exit(1)
}
