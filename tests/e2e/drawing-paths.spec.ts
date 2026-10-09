// Drawing storage e2e — 磁盘文件名必须跟着标签走。
//
// 这里刻意走真实应用（Playwright 的 electron driver + 真正的
// drawing.save / drawing.rename IPC），因为断言的是「DB 映射 → 磁盘投影」
// 这条只有跑起来才看得见的链路：单测只覆盖 store 层。

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type AppHandle } from './helpers';

/** 数据目录下的所有绘图场景文件名（不含缩略图）。 */
function sceneFileNames(dataDir: string): string[] {
  const todosDir = join(dataDir, 'todos');
  if (!existsSync(todosDir)) return [];
  const out: string[] = [];
  for (const dirent of readdirSync(todosDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    for (const file of readdirSync(join(todosDir, dirent.name))) {
      if (file.endsWith('.excalidraw')) out.push(file);
    }
  }
  return out.sort();
}

/** 找到某个绘图文件的完整路径（数据目录里可能有多个任务子目录）。 */
function sceneFilePath(dataDir: string, name: string): string {
  const todosDir = join(dataDir, 'todos');
  for (const dirent of readdirSync(todosDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(todosDir, dirent.name, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`scene file not found: ${name}`);
}

interface TodoListWindow {
  todoList: {
    todo: { create: (i: { title: string }) => Promise<{ ok: boolean; data?: { id?: string } }> };
    drawing: {
      save: (todoId: string, scene: unknown) => Promise<{ ok: boolean; data?: { id?: string; title?: string | null } }>;
      rename: (id: string, title: string) => Promise<{ ok: boolean; data?: { title?: string | null } }>;
      read: (id: string) => Promise<{ ok: boolean; data?: unknown }>;
    };
  };
}

async function createTaskAndDrawing(handle: AppHandle): Promise<{ todoId: string; drawingId: string }> {
  const ids = await handle.win.evaluate(async () => {
    const w = window as unknown as TodoListWindow;
    const todo = await w.todoList.todo.create({ title: '绘图测试任务' });
    const todoId = todo.ok ? todo.data?.id : undefined;
    if (!todoId) throw new Error('todo.create failed');
    const drawing = await w.todoList.drawing.save(todoId, { elements: [], appState: {} });
    const drawingId = drawing.ok ? drawing.data?.id : undefined;
    if (!drawingId) throw new Error('drawing.save failed');
    return { todoId, drawingId };
  });
  return ids;
}

test.describe('绘图文件命名', () => {
  test('新建绘图落成 绘图.excalidraw,改名后文件跟着标签走', async () => {
    const handle = await launchApp();
    try {
      const { drawingId } = await createTaskAndDrawing(handle);

      // 默认标签 + 默认文件名
      expect(sceneFileNames(handle.dataDir)).toEqual(['绘图.excalidraw']);

      // 改名 → 文件同步改名
      const renamed = await handle.win.evaluate(async (id) => {
        const w = window as unknown as TodoListWindow;
        const r = await w.todoList.drawing.rename(id, '架构图');
        return { ok: r.ok, title: r.data?.title ?? null };
      }, drawingId);
      expect(renamed).toEqual({ ok: true, title: '架构图' });
      expect(sceneFileNames(handle.dataDir)).toEqual(['架构图.excalidraw']);

      // 文件内容仍是刚保存的场景（改名只动文件名，不动数据）
      const scene = await handle.win.evaluate(async (id) => {
        const w = window as unknown as TodoListWindow;
        const r = await w.todoList.drawing.read(id);
        return r.data ?? null;
      }, drawingId);
      expect(scene).toEqual({ elements: [], appState: {} });
    } finally {
      await handle.app.close();
    }
  });

  test('第二张绘图拿到 绘图_2.excalidraw,自动保存不会退回 untitled', async () => {
    const handle = await launchApp();
    try {
      await createTaskAndDrawing(handle);
      await handle.win.evaluate(async () => {
        const w = window as unknown as TodoListWindow;
        const todos = await w.todoList.todo.create({ title: '第二张绘图任务' });
        const todoId = todos.ok ? todos.data?.id : undefined;
        if (!todoId) throw new Error('todo.create failed');
        const first = await w.todoList.drawing.save(todoId, { elements: [], appState: {} });
        const firstId = first.data?.id;
        const second = await w.todoList.drawing.save(todoId, { elements: [], appState: {} });
        const secondId = second.data?.id;
        if (!firstId || !secondId) throw new Error('drawing.save failed');
        // 自动保存（不带 title）不应清空标签
        await w.todoList.drawing.save(todoId, { elements: [{ id: 'e1' }], appState: {} }, firstId);
      });

      const names = sceneFileNames(handle.dataDir);
      expect(names).toContain('绘图.excalidraw');
      expect(names).toContain('绘图_2.excalidraw');
      expect(names).not.toContain('untitled.excalidraw');
    } finally {
      await handle.app.close();
    }
  });

  test('Ctrl+S 直接保存,不会弹出另存为对话框', async () => {
    const handle = await launchApp();
    try {
      const { todoId, drawingId } = await createTaskAndDrawing(handle);
      await handle.win.evaluate((id) => {
        location.hash = `/todo/${id.todoId}/drawing/${id.drawingId}`;
      }, { todoId, drawingId });

      // 等 Excalidraw 画布挂载（动态 import，可能要几秒）
      await handle.win.waitForSelector('.excalidraw canvas', { timeout: 30_000 });
      // 挂载后的首帧会触发一次自动保存，等它落盘完，Ctrl+S 才是唯一变量。
      await handle.win.waitForTimeout(2000);

      const file = sceneFilePath(handle.dataDir, '绘图.excalidraw');
      const settled = statSync(file).mtimeMs;
      await handle.win.waitForTimeout(1000);
      expect(statSync(file).mtimeMs).toBe(settled); // 没有后台写入在动

      await handle.win.keyboard.press('Control+s');

      // 两条独立证据：
      // 1) 下面的 evaluate 能返回 → 渲染进程没被「另存为」对话框卡住；
      // 2) 文件 mtime 变了 → Ctrl+S 真的走到了 main 并写了场景文件。
      await expect
        .poll(() => statSync(file).mtimeMs, { timeout: 10_000 })
        .toBeGreaterThan(settled);
      // 保存成功的 toast 只在任务列表面板在场时才可见（ToastHost 挂在那儿），
      // 这个深链路由没有它 —— 所以断言落在磁盘副作用上，不依赖 UI 提示。
      expect(sceneFileNames(handle.dataDir)).toEqual(['绘图.excalidraw']);
    } finally {
      await handle.app.close();
    }
  });
});