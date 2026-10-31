import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, openAiPane } from './helpers';

test('native steer reaches the next model step in the same active invocation and persists in history', async () => {
  let arrived!: () => void, release!: () => void;
  const firstRequest = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let steerSeen = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const first = request.tools?.length && !request.messages.some((message: { role: string }) => message.role === 'tool');
      if (first) { arrived(); await gate; }
      if (request.tools?.length && !first) steerSeen = request.messages.some((message: { role: string; content?: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('STEER_SAME_TURN'));
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'stats', type: 'function', function: { name: 'todo_stats', arguments: '{}' } }] }
        : { role: 'assistant', content: request.tools?.length ? steerSeen ? 'STEER_SEEN' : 'STEER_MISSING' : 'Steer test' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'steer', object: 'chat.completion.chunk', model: 'steer-test', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(frame(delta, null)); res.write(frame({}, first ? 'tool_calls' : 'stop')); res.end('data: [DONE]\n\n');
    })().catch(error => { res.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    const id = await handle.win.evaluate(async port => {
      await window.todoList.settings.set({ provider: 'custom', customProviderId: 'steer-test', customProviders: [{ id: 'steer-test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'steer-test' }] });
      const conversation = await window.todoList.conversation.create({ title: '原生 Steer 验证' }); if (!conversation.ok) throw Error(conversation.message); return conversation.data.conversation.id;
    }, port);
    const active = handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, invocationId: 'same-invocation', prompt: '读取任务统计后继续回答。' }), id);
    await firstRequest;
    const accepted = await handle.win.evaluate(id => window.todoList.ai.steer({ conversationId: id, invocationId: 'same-invocation', prompt: 'STEER_SAME_TURN：后续回答请使用中文。' }), id);
    expect(accepted.ok && accepted.data.accepted).toBe(true);
    const running = await handle.win.evaluate(id => window.todoList.ai.execution(id), id);
    expect(running.ok && running.data.invocations).toHaveLength(1);
    release();
    const result = await active;
    expect(result.ok && result.data.content).toContain('STEER_SEEN'); expect(steerSeen).toBe(true);
    const history = await handle.win.evaluate(id => window.todoList.conversation.history(id), id);
    expect(history.ok && history.data.turns.some(turn => turn.type === 'user' && turn.text.includes('STEER_SAME_TURN'))).toBe(true);
  } finally { release(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('streamed text is visible before Stop and Stop waits for actual backend cancellation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const main = JSON.parse(raw).tools?.length > 0;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content: string, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'stream-test', created: 1, choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason }] })}\n\n`;
    res.write(chunk(main ? 'VISIBLE_BEFORE_STOP' : 'Stream test', null));
    if (main) await gate;
    res.write(chunk('', 'stop')); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    await handle.win.evaluate(port => window.todoList.settings.set({ provider: 'custom', customProviderId: 'test', customProviders: [{ id: 'test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'stream-test' }] }), port);
    await handle.win.getByRole('textbox', { name: '向 AI 提问' }).fill('持续输出测试');
    await handle.win.getByRole('button', { name: '发送', exact: true }).click();
    await expect(handle.win.getByText('VISIBLE_BEFORE_STOP', { exact: true }).first()).toBeVisible();
    const current = await handle.win.evaluate(() => window.todoList.conversation.list({ limit: 1 }));
    if (!current.ok) throw Error(current.message);
    const id = current.data.conversations[0]!.id;
    const before = await handle.win.evaluate(id => window.todoList.ai.execution(id), id);
    expect(before.ok && before.data.invocations.length).toBe(1);
    await handle.win.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.ai.execution(id), id); return result.ok && !result.data.agentRunning && result.data.invocations.length === 0; }).toBe(true);
    await expect(handle.win.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(handle.win.getByText('VISIBLE_BEFORE_STOP', { exact: true }).first()).toBeVisible();
  } finally { release(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('reload recovers authoritative running state and clears it only after backend finishes', async () => {
  let globRoot = '';
  let received!: () => void; let release!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.tools?.length) { received(); await gate; }
    const recovery = request.tools?.length && request.messages.some((message: { role: string; content?: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('PS_RECOVERY_TEST'));
    const glob = request.tools?.length && request.messages.some((message: { role: string; content?: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('GLOB_NATIVE_TEST'));
    const invokeGlob = glob && !request.messages.some((message: { role: string }) => message.role === 'tool');
    const invokePowerShell = recovery && !request.messages.some((message: { role: string }) => message.role === 'tool');
    const delta = invokeGlob
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'glob-probe', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/glob-probe.txt', path: globRoot }) } }] }
      : invokePowerShell
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ps-recovery', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify({ command: "Write-Output 'PS_PROBE'; exit 7", description: '验证 PowerShell 非零退出后继续' }) } }] }
      : { role: 'assistant', content: glob ? 'GLOB_FINISHED' : recovery ? 'PS_RECOVERY_OK' : 'EXECUTION_FINISHED' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'state-test', created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'state-test', created: 1, choices: [{ index: 0, delta: {}, finish_reason: invokePowerShell || invokeGlob ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    const id = await handle.win.evaluate(async port => {
      await window.todoList.settings.set({ provider: 'custom', customProviderId: 'test', customProviders: [{ id: 'test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'state-test' }] });
      const result = await window.todoList.conversation.create({ title: '执行状态验证' }); if (!result.ok) throw Error(result.message);
      return result.data.conversation.id;
    }, port);
    await handle.win.evaluate(id => { void window.todoList.ai.ask({ conversationId: id, prompt: '回复状态标记' }); }, id);
    await requested;
    const snapshot = await handle.win.evaluate(id => window.todoList.ai.execution(id), id);
    expect(snapshot.ok && snapshot.data.invocations).toHaveLength(1);
    await handle.win.reload(); await openAiPane(handle.win);
    await expect(handle.win.getByRole('status', { name: '实际执行状态' })).toHaveText('后台正在执行…');
    await handle.win.screenshot({ path: test.info().outputPath('backend-running-after-reload.png') });
    release();
    await expect.poll(async () => { const result = await handle.win.evaluate(id => window.todoList.ai.execution(id), id); return result.ok ? result.data.invocations.length : -1; }).toBe(0);
    await expect(handle.win.getByRole('status', { name: '实际执行状态' })).toHaveCount(0);
    await expect(handle.win.getByText('EXECUTION_FINISHED', { exact: true }).first()).toBeVisible();
    await handle.win.evaluate(id => window.todoList.aiPermissionPreset.set({ conversationId: id, preset: 'danger-full-access' }), id);
    const recovery = await handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: 'PS_RECOVERY_TEST' }), id);
    expect(recovery.ok && recovery.data.content).toContain('PS_RECOVERY_OK');
    const history = await handle.win.evaluate(id => window.todoList.conversation.history(id), id);
    if (!history.ok) throw Error(history.message);
    const tool = history.data.turns.find(turn => turn.type === 'tool' && turn.name === 'pwsh');
    expect(JSON.stringify(tool && 'data' in tool ? tool.data : null)).toContain('PS_PROBE');
    expect(JSON.stringify(tool && 'data' in tool ? tool.data : null)).toContain('exit code: 7');
    const settings = await handle.win.evaluate(() => window.todoList.settings.get());
    if (!settings.ok || !settings.data.dshWorkspaceDir) throw Error('Missing test workspace');
    expect(settings.data.dshWorkspaceDir.startsWith(handle.dataDir)).toBe(true);
    globRoot = settings.data.dshWorkspaceDir;
    writeFileSync(join(settings.data.dshWorkspaceDir, 'glob-probe.txt'), 'isolated ripgrep execution probe');
    const globId = await handle.win.evaluate(async () => {
      const result = await window.todoList.conversation.create({ title: '原生 glob 验证' }); if (!result.ok) throw Error(result.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: result.data.conversation.id, preset: 'danger-full-access' }); return result.data.conversation.id;
    });
    const globResult = await handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: 'GLOB_NATIVE_TEST' }), globId);
    expect(globResult.ok && globResult.data.content).toContain('GLOB_FINISHED');
    const globHistory = await handle.win.evaluate(id => window.todoList.conversation.history(id), globId);
    if (!globHistory.ok) throw Error(globHistory.message);
    const globTool = globHistory.data.turns.find(turn => turn.type === 'tool' && turn.name === 'glob');
    expect(globTool && 'ok' in globTool && globTool.ok).toBe(true);
    expect(JSON.stringify(globTool && 'data' in globTool ? globTool.data : null)).toContain('glob-probe.txt');
  } finally { release(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
