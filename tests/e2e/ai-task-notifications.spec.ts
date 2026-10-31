import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { launchApp, openAiPane } from './helpers';

test('interactive and automated AI task creation show clickable desktop notifications', async () => {
  let created = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'notification-test' }] })); return; }
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    const finished = !body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === 'todo_create') || body.messages.some((message: { role: string }) => message.role === 'tool');
    const delta = finished ? { role: 'assistant', content: '已创建任务。' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: `create-${++created}`, type: 'function', function: { name: 'todo_create', arguments: JSON.stringify({ title: `桌面通知验证 ${created}` }) } }],
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'notification-test', created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'notification-test', created: 1, choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    await handle.app.evaluate(({ Notification }) => {
      (globalThis as any).__taskNotifications = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function () { (globalThis as any).__taskNotifications.push(this); };
    });
    await handle.win.evaluate(async port => {
      await window.todoList.settings.set({ provider: 'custom', customProviderId: 'test', customProviders: [{ id: 'test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'notification-test' }] });
      const result = await window.todoList.conversation.create({ title: '通知验证' }); if (!result.ok) throw Error(result.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: result.data.conversation.id, preset: 'danger-full-access' });
      const answer = await window.todoList.ai.ask({ conversationId: result.data.conversation.id, prompt: '创建桌面通知验证任务', intent: 'create-task' });
      if (!answer.ok) throw Error(answer.message);
    }, port);
    const notifications = () => handle.app.evaluate(() => (globalThis as any).__taskNotifications.map((notification: any) => ({ title: notification.title, body: notification.body })));
    await expect.poll(notifications).toEqual([{ title: 'AI 新增任务', body: '桌面通知验证 1' }]);
    await handle.win.evaluate(async () => {
      const saved = await window.todoList.automation.save({ name: '自动化通知验证', prompt: '创建一个通知验证任务', enabled: false, permissionPreset: 'danger-full-access', timezone: 'Asia/Shanghai', schedule: { kind: 'interval', minutes: 60 } });
      if (!saved.ok) throw Error(saved.message);
      const result = await window.todoList.automation.run(saved.data.id); if (!result.ok) throw Error(result.message);
    });
    await expect.poll(notifications).toEqual([{ title: 'AI 新增任务', body: '桌面通知验证 1' }, { title: '自动化新增任务', body: '桌面通知验证 2' }]);
    const tasks = await handle.win.evaluate(() => window.todoList.todo.list({}));
    if (!tasks.ok) throw Error(tasks.message);
    const task = tasks.data.find(task => task.title === '桌面通知验证 2')!;
    expect(task).toBeTruthy();
    await handle.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#/compact'))!.minimize();
      (globalThis as any).__taskNotifications[1].emit('click');
    });
    await expect.poll(() => handle.win.evaluate(() => location.hash)).toBe(`#/todo/${task.id}`);
    await expect(handle.win.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  } finally { await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
