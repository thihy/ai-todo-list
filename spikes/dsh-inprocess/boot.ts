// Spike: prove @deepseek-ai/dsh-app-boot's boot() runs in-process from npm packages.
import { boot } from '@deepseek-ai/dsh-app-boot'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = resolve(here, 'cordis.yml')
console.log('[spike] booting', cfg)
try {
  const ctx = await boot('thihy-spike', cfg)
  console.log('[spike] boot() OK — context returned')
  console.log('[spike] ctx.get("loader"):', typeof ctx.get('loader'))
  // List what top-level services we can see
  const tryGet = ['loader', 'agentLoop', 'agents', 'llm', 'tools', 'systemPrompt', 'sessions']
  for (const k of tryGet) {
    const v = ctx.get(k)
    console.log(`[spike] ctx.get('${k}'):`, v === undefined ? 'absent' : typeof v)
  }
  await ctx.fiber?.dispose?.()
  console.log('[spike] disposed')
} catch (err) {
  console.error('[spike] boot FAILED:', (err as Error).message)
  process.exit(1)
}
