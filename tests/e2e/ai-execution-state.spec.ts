import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { launchApp, openAiPane } from './helpers';

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
  let received!: () => void; let release!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.tools?.length) { received(); await gate; }
    const recovery = request.tools?.length && request.messages.some((message: { role: string; content?: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('PS_RECOVERY_TEST'));
    const invokePowerShell = recovery && !request.messages.some((message: { role: string }) => message.role === 'tool');
    const delta = invokePowerShell
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ps-recovery', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify({ command: "Write-Output 'PS_PROBE'; exit 7", description: '验证 PowerShell 非零退出后继续' }) } }] }
      : { role: 'assistant', content: recovery ? 'PS_RECOVERY_OK' : 'EXECUTION_FINISHED' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'state-test', created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'state-test', created: 1, choices: [{ index: 0, delta: {}, finish_reason: invokePowerShell ? 'tool_calls' : 'stop' }] })}\n\n`);
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
  } finally { release(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
