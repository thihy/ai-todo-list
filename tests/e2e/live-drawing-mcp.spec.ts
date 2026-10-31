import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { launchApp, openAiPane } from './helpers';

test('DSH calls native MCP tools against the mounted editor, deduplicates, rejects conflicts, persists, reverts and respects read-only', async () => {
  test.setTimeout(90000);
  let drawingId = ''; let applyArgs: any; let firstContext: any; let finalContext: any;
  let advertised: string[] = []; let editResults: any[] = []; let deniedResult = ''; let serverError = '';
  let concurrentReady!: () => void; let releaseConcurrent!: () => void;
  const concurrentPlanned = new Promise<void>(resolve => { concurrentReady = resolve; });
  const concurrentGate = new Promise<void>(resolve => { releaseConcurrent = resolve; });
  let concurrentResult = '';
  let concurrentSnapshot = '';
  const content = (value: unknown): string => typeof value === 'string' ? value : (value as Array<{ text?: string }>).map(block => block.text ?? '').join('');
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const tools = request.messages.filter((message: any) => message.role === 'tool');
      const denying = request.messages.some((message: any) => message.role === 'user' && content(message.content).includes('MCP_READ_ONLY'));
      const concurrent = request.messages.some((message: any) => message.role === 'user' && content(message.content).includes('MCP_CONCURRENT'));
      let call: { name: string; arguments: unknown } | undefined;
      if (request.tools?.length) {
        advertised = request.tools.map((tool: any) => tool.function.name);
        if (tools.length === 0) call = { name: 'mcp__drawing__get_context', arguments: {} };
        else if (concurrent) {
          if (tools.length === 1) {
            const context = JSON.parse(content(tools[0].content));
            call = { name: 'mcp__drawing__apply_operations', arguments: { drawingId, opId: 'concurrent-op', baseRevision: context.revision, operations: [{ kind: 'update', id: context.elements[0].id, changes: { text: 'MUST_NOT_APPEAR' } }] } };
            concurrentReady(); await concurrentGate;
          } else {
            concurrentResult = content(tools.at(-1).content);
            concurrentSnapshot = request.messages.filter((message: any) => message.role === 'user')
              .map((message: any) => content(message.content)).filter((text: string) => text.includes('实时绘图数据')).at(-1) ?? '';
          }
        } else if (denying) {
          if (tools.length === 1) {
            const context = JSON.parse(content(tools[0].content));
            call = { name: 'mcp__drawing__apply_operations', arguments: { drawingId, opId: 'denied-op', baseRevision: context.revision, operations: [{ kind: 'update', id: context.elements[0].id, changes: { text: 'MUST_NOT_APPEAR' } }] } };
          } else deniedResult = content(tools.at(-1).content);
        } else {
          firstContext = JSON.parse(content(tools[0].content));
          const selected = firstContext.selectedElementIds[0];
          if (!selected) throw Error(`The mounted engine did not expose the real selection: ${JSON.stringify(firstContext)}`);
          if (tools.length === 1) call = { name: 'mcp__drawing__read_elements', arguments: { drawingId, ids: [selected] } };
          if (tools.length === 2) {
            const read = JSON.parse(content(tools[1].content));
            applyArgs = { drawingId, opId: 'live-op', baseRevision: read.revision, operations: [
              { kind: 'update', id: selected, changes: { text: 'AI 修改的原节点', backgroundColor: '#a5d8ff' } },
              { kind: 'add', element: { id: 'ai-added', type: 'ellipse', x: firstContext.elements[0].x + 280, y: firstContext.elements[0].y, width: 140, height: 80, text: '新增节点' } },
              { kind: 'connect', id: 'ai-edge', from: selected, to: 'ai-added', label: '下一步' },
            ] };
            call = { name: 'mcp__drawing__apply_operations', arguments: applyArgs };
          }
          if (tools.length === 3) call = { name: 'mcp__drawing__apply_operations', arguments: applyArgs };
          if (tools.length === 4) call = { name: 'mcp__drawing__get_context', arguments: { drawingId } };
          if (tools.length === 5) {
            finalContext = JSON.parse(content(tools[4].content));
            call = { name: 'mcp__drawing__apply_operations', arguments: { drawingId, opId: 'stale-op', baseRevision: firstContext.revision, operations: [{ kind: 'update', id: selected, changes: { text: 'MUST_NOT_APPEAR' } }] } };
          }
          if (tools.length === 6) call = { name: 'mcp__drawing__get_operation', arguments: { drawingId, opId: 'query', targetOpId: 'live-op' } };
          if (tools.length >= 7) editResults = tools.map((message: any) => { try { return JSON.parse(content(message.content).replace(/^Error:\s*/, '')); } catch { return content(message.content); } });
        }
      }
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${tools.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
        : { role: 'assistant', content: request.tools?.length ? concurrent ? 'MCP_CONCURRENT_OK' : denying ? 'MCP_READ_ONLY_OK' : 'LIVE_MCP_OK' : '绘图验证' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'drawing-test', object: 'chat.completion.chunk', model: 'drawing-test', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(frame(delta, null)); res.write(frame({}, call ? 'tool_calls' : 'stop')); res.end('data: [DONE]\n\n');
    })().catch(error => { serverError = String(error); res.writeHead(500).end(serverError); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const handle = await launchApp();
  try {
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#/compact'))!.setSize(1600, 950));
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    const ids = await handle.win.evaluate(async port => {
      await window.todoList.settings.set({ provider: 'custom', customProviderId: 'drawing-test', customProviders: [{ id: 'drawing-test', name: 'Test', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'drawing-test' }] });
      const todo = await window.todoList.todo.create({ title: '真实 MCP 绘图集成验证' }); if (!todo.ok) throw Error(todo.message);
      const drawing = await window.todoList.drawing.save(todo.data.id, { elements: [], appState: {} }); if (!drawing.ok) throw Error(drawing.message);
      const conversation = await window.todoList.conversation.create({ title: '实时绘图验证' }); if (!conversation.ok) throw Error(conversation.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: conversation.data.conversation.id, preset: 'danger-full-access' });
      return { todoId: todo.data.id, drawingId: drawing.data.id, conversationId: conversation.data.conversation.id };
    }, port);
    drawingId = ids.drawingId;
    await handle.win.evaluate(ids => { location.hash = `/todo/${ids.todoId}/drawing/${ids.drawingId}`; }, ids);
    await handle.win.waitForSelector('.excalidraw canvas', { timeout: 30000 });
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const editor = handle.win.locator('.excalidraw');
    await editor.evaluate(element => { (element as HTMLElement).tabIndex = -1; (element as HTMLElement).focus(); });
    const bounds = await editor.boundingBox(); if (!bounds) throw Error('Missing canvas bounds');
    await editor.getByTestId('toolbar-rectangle').locator('..').click();
    await expect(editor.getByTestId('toolbar-rectangle')).toBeChecked();
    await handle.win.mouse.move(bounds.x + 400, bounds.y + 300); await handle.win.mouse.down();
    await handle.win.waitForTimeout(100);
    await handle.win.mouse.move(bounds.x + 560, bounds.y + 380, { steps: 10 });
    await handle.win.waitForTimeout(100); await handle.win.mouse.up();
    await editor.getByTestId('toolbar-selection').locator('..').click();
    await handle.win.mouse.click(bounds.x + 400, bounds.y + 340);
    await handle.win.screenshot({ path: test.info().outputPath('live-mcp-selection.png') });
    const asked = await handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: 'LIVE_MCP_EDIT：修改我选中的节点并连接一个新节点。' }), ids.conversationId);
    expect(serverError).toBe('');
    expect(asked.ok && asked.data.content).toContain('LIVE_MCP_OK');
    expect(advertised).toContain('mcp__drawing__apply_operations');
    expect(firstContext.selectedElementIds).toHaveLength(1);
    expect(finalContext.viewport).toEqual(firstContext.viewport);
    expect(finalContext.selectedElementIds).toEqual(firstContext.selectedElementIds);
    expect(editResults[2]).toMatchObject({ ok: true, durable: true });
    expect(editResults[3]).toEqual(editResults[2]);
    expect(editResults[5]).toMatchObject({ ok: false, code: 'conflict', liveChanged: false });
    expect(editResults[6]).toEqual(editResults[2]);
    const persisted = await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId);
    expect(persisted.ok).toBe(true);
    const elements = (persisted as any).data.elements;
    expect(elements.filter((element: any) => element.id === 'ai-added')).toHaveLength(1);
    expect(elements.find((element: any) => element.id === 'ai-edge')).toMatchObject({ startBinding: { elementId: firstContext.selectedElementIds[0] }, endBinding: { elementId: 'ai-added' } });
    expect(elements.some((element: any) => element.text === 'AI 修改的原节点')).toBe(true);
    expect(JSON.stringify(elements)).not.toContain('MUST_NOT_APPEAR');
    await expect(handle.win.getByRole('button', { name: '撤销 AI 修改', exact: true })).toBeVisible();
    await handle.win.screenshot({ path: test.info().outputPath('live-mcp-edit.png') });
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#/compact'))!.setSize(1000, 760));
    const revert = handle.win.getByRole('button', { name: '撤销 AI 修改', exact: true });
    await revert.click({ trial: true });
    const actionBounds = await revert.boundingBox(), narrowBounds = await editor.boundingBox();
    expect(actionBounds!.x).toBeGreaterThanOrEqual(narrowBounds!.x);
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(narrowBounds!.x + narrowBounds!.width);
    await handle.win.screenshot({ path: test.info().outputPath('live-mcp-edit-narrow.png') });
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#/compact'))!.setSize(1600, 950));
    await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(800);
    await handle.win.getByRole('button', { name: '撤销 AI 修改', exact: true }).click();
    await expect(handle.win.getByRole('button', { name: '撤销 AI 修改', exact: true })).toHaveCount(0);
    const restored = await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId);
    expect((restored as any).data.elements).toHaveLength(1);
    expect((restored as any).data.elements[0].id).toBe(firstContext.selectedElementIds[0]);
    await handle.win.evaluate(id => { location.hash = `/todo/${id}`; }, ids.todoId);
    await expect(editor).toHaveCount(0);
    await handle.win.evaluate(ids => { location.hash = `/todo/${ids.todoId}/drawing/${ids.drawingId}`; }, ids);
    await expect(editor.locator('canvas').first()).toBeVisible();
    const readonlyId = await handle.win.evaluate(async () => {
      const conversation = await window.todoList.conversation.create({ title: '只读绘图验证' }); if (!conversation.ok) throw Error(conversation.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: conversation.data.conversation.id, preset: 'read-only' }); return conversation.data.conversation.id;
    });
    const denied = await handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: 'MCP_READ_ONLY：尝试修改当前绘图，工具拒绝后正常回答。' }), readonlyId);
    expect(denied.ok && denied.data.content).toContain('MCP_READ_ONLY_OK');
    expect(deniedResult).toContain('只读');
    expect(JSON.stringify(await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId))).not.toContain('MUST_NOT_APPEAR');
    const concurrentId = await handle.win.evaluate(async () => {
      const conversation = await window.todoList.conversation.create({ title: '手工并发修改验证' }); if (!conversation.ok) throw Error(conversation.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: conversation.data.conversation.id, preset: 'danger-full-access' }); return conversation.data.conversation.id;
    });
    const concurrentAsk = handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: 'MCP_CONCURRENT：读取画布，然后尝试修改。' }), concurrentId);
    await concurrentPlanned;
    // The model is reasoning against the old revision while the user adds a real shape.
    await editor.getByTestId('toolbar-rectangle').locator('..').click();
    await handle.win.mouse.move(bounds.x + 400, bounds.y + 500); await handle.win.mouse.down();
    await handle.win.waitForTimeout(100); await handle.win.mouse.move(bounds.x + 560, bounds.y + 580, { steps: 10 });
    await handle.win.waitForTimeout(100); await handle.win.mouse.up();
    releaseConcurrent();
    const concurrentDone = await concurrentAsk;
    expect(concurrentDone.ok && concurrentDone.data.content).toContain('MCP_CONCURRENT_OK');
    expect(concurrentResult).toContain('conflict');
    // No extra drawing read was called after the user's edit. Native runtime context
    // still refreshed before the next model request, independently of tool results.
    expect(concurrentSnapshot).toContain('"elementCount":2');
    expect(concurrentSnapshot).toContain('"changes":');
    expect(concurrentSnapshot).not.toContain('"available":false');
    const history = await handle.win.evaluate(id => window.todoList.conversation.history(id), concurrentId);
    expect(history.ok).toBe(true);
    expect(JSON.stringify(history)).not.toContain('实时绘图数据');
    await expect.poll(async () => {
      const result = await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId);
      return result.ok ? (result.data as any).elements.length : 0;
    }).toBe(2);
    expect(JSON.stringify(await handle.win.evaluate(id => window.todoList.drawing.read(id), drawingId))).not.toContain('MUST_NOT_APPEAR');
  } finally { releaseConcurrent(); await handle.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
