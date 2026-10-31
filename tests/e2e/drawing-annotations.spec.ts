import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { launchApp, openAiPane } from './helpers';
import { drawingBridge, installDrawingAckRecorder } from './drawing-engine-helpers';

test('selection annotations survive tab changes and submit once through the collapsed assistant into real native actions', async () => {
  test.setTimeout(90000);
  let drawingId = '', batchPrompt = '', toolNames: string[] = [], serverError = '';
  let firstRequestReady!: () => void, releaseFirst!: () => void;
  const firstRequest = new Promise<void>(resolve => { firstRequestReady = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let editsReady!: () => void, releaseFinal!: () => void;
  const edits = new Promise<void>(resolve => { editsReady = resolve; });
  const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
  const plain = (value: any): string => typeof value === 'string' ? value : (value ?? []).map((block: any) => block.text ?? '').join('');
  const server = createServer((req, res) => { void (async () => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const tools = request.messages.filter((message: any) => message.role === 'tool');
    let call: any;
    const latestBatch = [...request.messages].reverse().filter((message: any) => message.role === 'user').map((message: any) => plain(message.content)).find((text: string) => text.startsWith('请批量处理这')) ?? '';
    const queuedBatch = latestBatch.includes('这 1 条绘图标注');
    if (request.tools?.length) {
      toolNames = request.tools.map((tool: any) => tool.function.name);
      batchPrompt = request.messages.filter((message: any) => message.role === 'user').map((message: any) => plain(message.content)).find((text: string) => text.includes('这 2 条绘图标注')) ?? batchPrompt;
      if (!queuedBatch && tools.length === 0) { firstRequestReady(); await firstGate; call = { name: 'mcp__drawing__get_actions', arguments: { drawingId } }; }
      if (!queuedBatch && tools.length === 1) call = { name: 'mcp__drawing__execute_action', arguments: { drawingId, opId: 'annotation-color', action: 'changeBackgroundColor', baseRevision: JSON.parse(plain(tools[0].content)).revision, elementIds: ['a'], value: { currentItemBackgroundColor: '#ffc9c9' } } };
      if (!queuedBatch && tools.length === 2) call = { name: 'mcp__drawing__execute_action', arguments: { drawingId, opId: 'annotation-align', action: 'alignTop', baseRevision: JSON.parse(plain(tools[1].content)).revision, elementIds: ['a', 'b'] } };
      if (!queuedBatch && tools.length >= 3) { editsReady(); await finalGate; }
    }
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `annotation-${tools.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: request.tools?.length ? queuedBatch ? '排队标注已收到' : '标注批量处理完成' : '批量标注验证' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'annotation-test', object: 'chat.completion.chunk', model: 'test', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(frame(delta, null)); res.write(frame({}, call ? 'tool_calls' : 'stop')); res.end('data: [DONE]\n\n');
  })().catch(error => { serverError = String(error); res.writeHead(500).end(serverError); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible({ timeout: 30000 });
    await installDrawingAckRecorder(handle);
    const fixture = JSON.parse(readFileSync('tests/fixtures/native-actions.excalidraw', 'utf8'));
    const ids = await handle.win.evaluate(async ({ fixture, port }) => {
      await window.todoList.settings.set({ provider: 'custom', customProviderId: 'annotation-test', customProviders: [{ id: 'annotation-test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'test' }] });
      const todo = await window.todoList.todo.create({ title: '标注批量提交验收' }); if (!todo.ok) throw Error(todo.message);
      const drawing = await window.todoList.drawing.save(todo.data.id, fixture); if (!drawing.ok) throw Error(drawing.message);
      return { todoId: todo.data.id, drawingId: drawing.data.id };
    }, { fixture, port });
    drawingId = ids.drawingId;
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: 'AI 权限预设', exact: true })).toBeEnabled({ timeout: 30000 });
    await handle.win.getByRole('button', { name: 'AI 权限预设', exact: true }).click();
    await handle.win.getByRole('option', { name: /完全访问/ }).click();
    await expect(handle.win.getByRole('status', { name: '实际执行状态' })).toHaveCount(0);
    const mount = async () => {
      await handle.win.evaluate(ids => { location.hash = `/todo/${ids.todoId}/drawing/${ids.drawingId}`; }, ids);
      await expect(handle.win.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30000 });
    };
    await mount();
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const select = async (id: string) => {
      const read = await drawingBridge(handle, 'app:drawing-context', { drawingId, opId: randomUUID() });
      const { viewport } = read.context;
      const box = await handle.win.locator('[aria-label="绘图画布"]').boundingBox(); if (!box) throw Error('Canvas missing');
      const element = read.context.elements.find((element: any) => element.id === id);
      // Click the visible stroke, outside the left property panel.
      const x = id === 'a' ? element.x + element.width : element.x;
      const y = element.y + element.height / 2;
      await handle.win.mouse.click(box.x + (x + viewport.scrollX) * viewport.zoom, box.y + (y + viewport.scrollY) * viewport.zoom);
      await expect(handle.win.getByLabel('AI 标注内容', { exact: true })).toBeVisible();
    };
    await select('a');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).fill('把这个元素改成粉红色');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).press('Enter');
    await select('b');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).fill('和第一个元素顶部对齐');
    await handle.win.screenshot({ path: test.info().outputPath('drawing-annotation-input.png') });
    await handle.win.getByLabel('AI 标注内容', { exact: true }).press('Enter');
    await handle.win.getByRole('button', { name: /^标注 2/ }).click();
    await expect(handle.win.getByLabel('编辑标注 1')).toHaveValue('把这个元素改成粉红色');
    await expect(handle.win.getByLabel('编辑标注 2')).toHaveValue('和第一个元素顶部对齐');
    await handle.win.screenshot({ path: test.info().outputPath('drawing-annotation-batch.png') });
    await handle.win.evaluate(id => { location.hash = `/todo/${id}`; }, ids.todoId);
    await expect(handle.win.locator('.excalidraw')).toHaveCount(0);
    await mount();
    await expect(handle.win.getByRole('button', { name: /^标注 2/ })).toBeVisible();
    await handle.win.getByRole('button', { name: '收起 AI 助手', exact: true }).click();
    await handle.win.getByRole('button', { name: '提交给 AI', exact: true }).click();
    await firstRequest;
    await expect(handle.win.getByRole('button', { name: '提交给 AI', exact: true })).toHaveCount(0);
    await select('b');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).fill('下一轮仅确认收到，不要改图');
    releaseFirst(); await edits;
    await expect(handle.win.getByLabel('AI 标注内容', { exact: true })).toHaveValue('下一轮仅确认收到，不要改图');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).press('Enter');
    await handle.win.getByRole('button', { name: '提交给 AI', exact: true }).click();
    await expect(handle.win.locator('.aipane__queue')).toContainText('下一轮仅确认收到，不要改图');
    await expect(handle.win.getByRole('button', { name: '提交给 AI', exact: true })).toHaveCount(0);
    releaseFinal();
    await expect(handle.win.getByText('标注批量处理完成', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(handle.win.getByText('排队标注已收到', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    expect(serverError).toBe(''); expect(batchPrompt).toContain('元素引用：a'); expect(batchPrompt).toContain('元素引用：b');
    expect(batchPrompt).toContain('把这个元素改成粉红色'); expect(batchPrompt).toContain('和第一个元素顶部对齐');
    expect(toolNames).toContain('mcp__drawing__execute_action'); expect(toolNames).not.toContain('drawing_read'); expect(toolNames).not.toContain('drawing_save');
    await expect(handle.win.getByRole('button', { name: '提交给 AI', exact: true })).toHaveCount(0);
    const saved = await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId);
    expect(saved.ok).toBe(true); const elements = (saved as any).data.elements;
    expect(elements.find((element: any) => element.id === 'a').backgroundColor).toBe('#ffc9c9');
    expect(elements.find((element: any) => element.id === 'a').y).toBe(elements.find((element: any) => element.id === 'b').y);
    const todos = await handle.win.evaluate(() => window.todoList.todo.list({})); expect(todos.ok && todos.data).toHaveLength(1);
  } finally { releaseFirst(); releaseFinal(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a blocked annotation admission keeps editable drafts and creates no conversation', async () => {
  test.setTimeout(45000);
  const handle = await launchApp();
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible({ timeout: 30000 });
    await installDrawingAckRecorder(handle);
    await openAiPane(handle.win);
    const fixture = JSON.parse(readFileSync('tests/fixtures/native-actions.excalidraw', 'utf8'));
    const ids = await handle.win.evaluate(async fixture => {
      const todo = await window.todoList.todo.create({ title: '标注草稿失败恢复验收' }); if (!todo.ok) throw Error(todo.message);
      const drawing = await window.todoList.drawing.save(todo.data.id, fixture); if (!drawing.ok) throw Error(drawing.message);
      location.hash = `/todo/${todo.data.id}/drawing/${drawing.data.id}`;
      return { todoId: todo.data.id, drawingId: drawing.data.id };
    }, fixture);
    await expect(handle.win.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30000 });
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const read = await drawingBridge(handle, 'app:drawing-context', { drawingId: ids.drawingId, opId: randomUUID() });
    const box = await handle.win.locator('[aria-label="绘图画布"]').boundingBox(); if (!box) throw Error('Missing canvas');
    await handle.win.mouse.click(box.x + (310 + read.context.viewport.scrollX) * read.context.viewport.zoom, box.y + (190 + read.context.viewport.scrollY) * read.context.viewport.zoom);
    await handle.win.getByLabel('AI 标注内容', { exact: true }).fill('这条要求不能丢失');
    await handle.win.getByLabel('AI 标注内容', { exact: true }).press('Enter');
    await handle.win.getByRole('button', { name: '提交给 AI', exact: true }).click();
    await expect(handle.win.locator('.drawing-annotation-notice')).toContainText('标注已保留', { timeout: 30000 });
    await expect(handle.win.getByRole('button', { name: '提交给 AI', exact: true })).toBeEnabled();
    await handle.win.getByRole('button', { name: /^标注 1/ }).click();
    await expect(handle.win.getByLabel('编辑标注 1')).toHaveValue('这条要求不能丢失');
    const conversations = await handle.win.evaluate(() => window.todoList.conversation.list());
    expect(conversations.ok && conversations.data.total).toBe(0);
  } finally { await handle.app.close(); }
});
