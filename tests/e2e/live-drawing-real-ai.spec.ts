import { test, expect } from '@playwright/test';
import { launchApp, openAiPane } from './helpers';

test('configured real model edits the current selection through native MCP from a natural-language request', async () => {
  test.skip(!process.env.TODO_E2E_REAL_AI_CONFIG, 'Opt in with a local app config path; credentials are never logged.');
  test.setTimeout(180000);
  const handle = await launchApp({ aiConfigPath: process.env.TODO_E2E_REAL_AI_CONFIG, compactWindow: { enabled: false } });
  try {
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#/compact'))!.setSize(1600, 950));
    await openAiPane(handle.win);
    await expect(handle.win.getByRole('button', { name: '新建对话', exact: true })).toBeEnabled({ timeout: 30000 });
    const ids = await handle.win.evaluate(async () => {
      const todo = await window.todoList.todo.create({ title: '真实模型绘图验证（隔离测试数据）' }); if (!todo.ok) throw Error(todo.message);
      const drawing = await window.todoList.drawing.save(todo.data.id, { elements: [], appState: {} }); if (!drawing.ok) throw Error(drawing.message);
      const conversation = await window.todoList.conversation.create({ title: '自然语言实时绘图验证' }); if (!conversation.ok) throw Error(conversation.message);
      await window.todoList.aiPermissionPreset.set({ conversationId: conversation.data.conversation.id, preset: 'danger-full-access' });
      return { todoId: todo.data.id, drawingId: drawing.data.id, conversationId: conversation.data.conversation.id };
    });
    await handle.win.evaluate(ids => { location.hash = `/todo/${ids.todoId}/drawing/${ids.drawingId}`; }, ids);
    const editor = handle.win.locator('.excalidraw');
    await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30000 });
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    await editor.getByTestId('toolbar-rectangle').locator('..').click();
    const bounds = await editor.boundingBox(); if (!bounds) throw Error('Missing canvas bounds');
    await handle.win.mouse.move(bounds.x + 400, bounds.y + 300); await handle.win.mouse.down();
    await handle.win.waitForTimeout(100); await handle.win.mouse.move(bounds.x + 560, bounds.y + 380, { steps: 10 });
    await handle.win.waitForTimeout(100); await handle.win.mouse.up();
    await editor.getByTestId('toolbar-selection').locator('..').click();
    await handle.win.mouse.click(bounds.x + 400, bounds.y + 340);
    const response = await handle.win.evaluate(id => window.todoList.ai.ask({ conversationId: id, prompt: '请直接把当前画布中选中的矩形的文字改成“实时辅助已验证”，填充颜色改为 #ffc9c9。只修改这个现有矩形，保留位置，不新建待办任务、不创建另一张绘图。完成后简短确认。' }), ids.conversationId);
    expect(response.ok, response.ok ? '' : response.message).toBe(true);
    const history = await handle.win.evaluate(id => window.todoList.conversation.history(id), ids.conversationId);
    if (!history.ok) throw Error(history.message);
    const tools = history.data.turns.filter(turn => turn.type === 'tool');
    expect(tools.some(turn => turn.type === 'tool' && turn.name === 'mcp__drawing__get_context')).toBe(true);
    expect(tools.some(turn => turn.type === 'tool' && turn.name === 'mcp__drawing__apply_operations' && turn.ok)).toBe(true);
    expect(tools.some(turn => turn.type === 'tool' && ['todo_create', 'drawing_save', 'drawing_draw'].includes(turn.name))).toBe(false);
    const saved = await handle.win.evaluate(id => window.todoList.drawing.read(id), ids.drawingId);
    expect(saved.ok).toBe(true);
    const elements = (saved as any).data.elements;
    expect(elements.find((element: any) => element.type === 'rectangle')).toMatchObject({ backgroundColor: '#ffc9c9' });
    expect(elements.find((element: any) => element.type === 'text')).toMatchObject({ originalText: '实时辅助已验证' });
    const todos = await handle.win.evaluate(() => window.todoList.todo.list({}));
    expect(todos.ok && todos.data.length).toBe(1);
    await handle.win.screenshot({ path: test.info().outputPath('real-ai-live-drawing.png') });
  } finally { await handle.app.close(); }
});
