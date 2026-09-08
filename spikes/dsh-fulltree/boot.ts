// Spike: prove @deepseek-ai/dsh-app-boot's boot() runs in-process from npm
// packages AND mounts the real agent plugin tree (llm + tools + system-prompt
// + session-persistence + agent-loop). Verifies ctx.llm/ctx.tools/ctx.agentLoop
// come alive and bare @deepseek-ai/dsh-* specifiers resolve via bareModuleBaseUrl.
import { boot } from '@deepseek-ai/dsh-app-boot'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = resolve(here, 'cordis.yml')
// Anchor bare @deepseek-ai/dsh-* specifiers to this spike's installed package
// tree (the Cordis Loader resolves them against this base).
const bareBase = new URL('.', pathToFileURL(here).href).href
console.log('[spike] booting', cfg)
console.log('[spike] bareModuleBaseUrl:', bareBase)
try {
  const ctx = await boot('thihy-spike', cfg, undefined, undefined, bareBase)
  console.log('[spike] boot() OK — context returned')
  const tryGet = ['loader', 'agentLoop', 'agents', 'llm', 'tools', 'systemPrompt', 'sessions']
  for (const k of tryGet) {
    const v = ctx.get(k)
    console.log(`[spike] ctx.get('${k}'):`, v === undefined ? 'absent' : typeof v)
  }
  // If llm is present, check registerAdapter exists (our integration seam).
  const llm = ctx.get('llm') as { registerAdapter?: unknown } | undefined
  console.log('[spike] ctx.llm.registerAdapter:', llm ? typeof llm.registerAdapter : 'n/a')
  const tools = ctx.get('tools') as { register?: unknown } | undefined
  console.log('[spike] ctx.tools.register:', tools ? typeof tools.register : 'n/a')
  await ctx.fiber?.dispose?.()
  console.log('[spike] disposed')
} catch (err) {
  console.error('[spike] boot FAILED:', (err as Error).message)
  console.error((err as Error).stack)
  process.exit(1)
}
