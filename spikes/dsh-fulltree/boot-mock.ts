// Spike: mock end-to-end agent turn. Registers a MockLlmAdapter (canned
// StreamChunk sequence, no HTTP) + an 'echo' tool via ctx.tools.register,
// creates an agent, drives a followup, and logs the llm/stream request +
// session/event flow. Verifies the full integration path WITHOUT needing
// real LLM credentials. This is the de-risk for the production wiring.
import { boot } from '@deepseek-ai/dsh-app-boot'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = resolve(here, 'cordis.yml')
const bareBase = new URL('.', pathToFileURL(here).href).href

// Track how many times the adapter is called (step 1 = initial text,
// step 2+ = after a tool result, yield a tool-call the first time, final text after).
let callCount = 0

class MockLlmAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: `Mock (${provider})` }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    callCount++
    console.log(`[mock-adapter] stream() call #${callCount}; provider=${options.provider} model=${options.model}; messages=${options.messages.length}; tools=${options.tools?.length ?? 0}`)

    // First call: emit a tool call (echo), so the loop runs our registered tool.
    if (callCount === 1 && options.tools?.length) {
      const tool = options.tools[0]
      console.log(`[mock-adapter] step 1: emitting tool-call for '${tool.name}'`)
      const idx = 0
      yield { type: 'block-start', index: idx, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: idx, id: ToolCallId('call-1') as any, name: tool.name, argumentsDelta: JSON.stringify({ text: 'hello from tool' }) }
      yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: ToolCallId('call-1') as any, name: tool.name, arguments: JSON.stringify({ text: 'hello from tool' }) } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    // Otherwise: final visible text.
    console.log(`[mock-adapter] step ${callCount}: emitting final text`)
    const idx = 0
    const text = 'Done. The echo tool returned successfully.'
    yield { type: 'block-start', index: idx, blockType: 'text' }
    for (const piece of ['Done. ', 'The echo tool ', 'returned successfully.']) {
      yield { type: 'text-delta', index: idx, text: piece }
    }
    yield { type: 'block-end', index: idx, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

console.log('[spike-mock] booting', cfg)
const ctx = await boot('thihy-mock-spike', cfg, undefined, undefined, bareBase)
console.log('[spike-mock] boot() OK')

// 1. Register our mock LLM adapter for the 'mock' provider route.
const llm = ctx.get('llm') as { registerAdapter: (p: string[], a: unknown) => () => void }
const disposeAdapter = llm.registerAdapter(['mock'], new MockLlmAdapter())
console.log('[spike-mock] registered MockLlmAdapter for provider "mock"')

// 2. Register an 'echo' tool.
const tools = ctx.get('tools') as { register: (d: unknown) => () => void }
const disposeTool = tools.register(defineTool({
  name: 'echo',
  description: 'Echo back the given text. Use this to confirm tool wiring.',
  parameters: {
    text: { type: 'string', required: true, description: 'The text to echo back.' },
  },
  output: {
    schema: { type: 'string' },
    render: (args: { text: string }, value: string) => [{ type: 'text', text: value }],
  },
  async execute(args: { text: string }) {
    console.log(`[tool:echo] execute called with args=${JSON.stringify(args)}`)
    return args.text
  },
}))
console.log('[spike-mock] registered echo tool')

// 3. Listen to the llm/stream waterfall (observe the assembled request) + session/event (durable flow).
ctx.on('llm/stream', (options: GenerateOptions, next: (o: GenerateOptions) => Promise<AsyncIterable<StreamChunk>>) => {
  console.log(`[llm/stream] request: provider=${options.provider} model=${options.model} msgs=${options.messages.length} tools=${options.tools?.length ?? 0}`)
  return next(options)
})

ctx.on('session/event', (e: { type: string; [k: string]: unknown }) => {
  // Only log the high-signal boundary + chunk + tool events.
  const t = e.type
  if (t === 'assistant/chunk') {
    const data = (e as { data?: { type?: string; text?: string; index?: number } }).data
    if (data?.type === 'text-delta') console.log(`[session/event] assistant/chunk text-delta: "${data.text}"`)
    else console.log(`[session/event] assistant/chunk ${data?.type} idx=${data?.index}`)
  } else if (t === 'tool/call' || t === 'tool/result') {
    console.log(`[session/event] ${t}`)
  } else if (t.startsWith('turn/') || t.startsWith('step/') || t === 'agent/status') {
    console.log(`[session/event] ${t}`)
  }
})

// 4. Create an agent using the mock provider + a registered tool.
const agents = ctx.get('agents') as {
  create: (o: unknown) => Promise<{ agent: { followup: (m: unknown) => void; whenIdle: () => Promise<void>; session: unknown; id: unknown }; dispose: () => Promise<void> }>
}
const handle = await agents.create({
  sessionId: SessionId('spike-mock-1'),
  agentOptions: { provider: 'mock', model: 'mock-model' },
  setup: () => {
    // tools.register in the agent scope would shadow globals; our global echo
    // is already visible, so no per-agent registration needed.
  },
})
console.log('[spike-mock] agent created:', handle.agent.id)

// 5. Drive a followup turn.
const userMsg = createUserMessage({
  content: [{ type: 'text', text: 'Please call the echo tool, then summarize.' }],
  source: { kind: 'user' },
})
console.log('[spike-mock] followup...')
handle.agent.followup(userMsg)

// 6. Wait for the driver to reach quiescence.
await handle.agent.whenIdle()
console.log('[spike-mock] driver idle. adapter was called', callCount, 'time(s).')

await handle.dispose()
disposeAdapter()
disposeTool()
await ctx.fiber?.dispose?.()
console.log('[spike-mock] disposed')
