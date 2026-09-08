// Replicates runTurn's exact flow under Electron's real Node 20, using the
// PRODUCTION cordis.yml (no session-persistence) + a mock adapter (no real LLM).
// If this hangs at agents.create / followup / whenIdle, the persistence removal
// broke the agent loop. If it completes, the loop is fine and the "no reaction"
// bug is in the real adapter's HTTP path.
//
// Run from project root: npx electron spikes/test-adapter/runturn-electron.mjs

import { app } from 'electron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cfg = resolve(projectRoot, 'resources/dsh/cordis.yml');
const bareBase = new URL('.', pathToFileURL(projectRoot).href).href;

const log = (m) => console.log(`[runturn] ${m}`);

// Step counter so the mock drives a tool-call then final text (like boot-mock).
let callCount = 0;

class MockAdapter extends LlmAdapter {
  providerInfo(p) { return { id: p, name: `Mock (${p})` }; }
  async *stream(options) {
    callCount++;
    log(`mock stream() #${callCount} provider=${options.provider} model=${options.model} tools=${options.tools?.length ?? 0}`);
    const idx = 0;
    if (callCount === 1 && options.tools?.length) {
      const tool = options.tools[0];
      log(`mock step1: tool-call for ${tool.name}`);
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm/brand');
      const id = ToolCallId('call-1');
      yield { type: 'block-start', index: idx, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: idx, id, name: tool.name, argumentsDelta: JSON.stringify({ text: 'hello' }) };
      yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: tool.name, arguments: JSON.stringify({ text: 'hello' }) } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    log(`mock step${callCount}: final text`);
    yield { type: 'block-start', index: idx, blockType: 'text' };
    yield { type: 'text-delta', index: idx, text: 'Done. Tool ran.' };
    yield { type: 'block-end', index: idx, block: { type: 'text', text: 'Done. Tool ran.' } };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function main() {
  const { boot } = await import('@deepseek-ai/dsh-app-boot');
  log(`boot() cfg=${cfg}`);
  const ctx = await boot('thihy-runturn-test', cfg, undefined, undefined, bareBase);
  log('boot ok');

  const llm = ctx.get('llm');
  llm.registerAdapter(['thihy'], new MockAdapter());
  log('adapter registered');

  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const tools = ctx.get('tools');
  tools.register(defineTool({
    name: 'echo',
    description: 'Echo text.',
    parameters: { text: { type: 'string', required: true, description: 'text' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'echo' }] },
    async execute(args) { log(`tool:echo execute ${JSON.stringify(args)}`); return args.text; },
  }));
  log('echo tool registered');

  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const agents = ctx.get('agents');
  log('agents.create...');
  const handle = await agents.create({ sessionId: SessionId('test-1'), agentOptions: { provider: 'thihy', model: 'mock' } });
  log('agent created');

  const callNames = new Map();
  const off = ctx.on('session/event', (session, event) => {
    const t = event?.type;
    if (t === 'assistant/chunk') {
      const chunk = event.data?.chunk;
      log(`event: ${t} chunk.type=${chunk?.type} text=${chunk?.text ? JSON.stringify(chunk.text).slice(0, 60) : ''}`);
    } else if (t === 'tool/call') {
      const d = event.data;
      if (d?.callId != null && d.name) callNames.set(String(d.callId), d.name);
      log(`event: ${t} name=${d?.name} callId=${d?.callId} args=${d?.arguments}`);
    } else if (t === 'tool/result') {
      const d = event.data;
      const block = d?.message?.content?.[0];
      const name = d?.message?.source?.callId != null ? (callNames.get(String(d.message.source.callId)) ?? '') : '';
      log(`event: ${t} name=${name} isError=${block?.isError} ok=${!block?.isError}`);
    } else {
      log(`event: ${t}`);
    }
  });

  const userMsg = createUserMessage({ content: [{ type: 'text', text: 'please echo hello' }], source: { kind: 'user' } });
  log('followup...');
  handle.agent.followup(userMsg);
  log('whenIdle... (waiting for agent loop)');
  await handle.agent.whenIdle();
  log('whenIdle resolved — loop complete');
  off();
  await handle.dispose();
  await ctx.fiber?.dispose?.();
  log('PASS: full runTurn flow completed without persistence');
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[runturn] FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});
