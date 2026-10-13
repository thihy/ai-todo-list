// 绘图数据变更的作用域扇出 —— 回归测试。
//
// 这里锁的是一个真实事故的两半：
//
// 1. 渲染端的 `useDrawing` 必须订阅 `'drawings'` scope。
//    AI 的 drawing_save 写完场景后要广播 `'drawings'`（ai-handlers 的
//    mutatingScopes），但订阅这个 scope 的一开始只有 useDrawings（列表）。
//    useDrawing（打开中的画布）只依赖 `[id]`，于是：列表刷新了、画布内容
//    纹丝不动；用户接着随手画一笔，ExcalidrawEditor 的 600ms autosave 会把
//    AI 刚写的场景整个覆盖掉。纯人工操作下这个不一致完全看不见。
//
// 2. main 端的绘图类工具必须同时广播 `'drawings'` 和 `'content'`。
//    tab 列表来自 useDocuments，它扫任务目录、订阅的是 `'content'`。
//    只推 `drawings` 时 AI 新建的绘图在 tab 里不出现 —— 这和 cb97bae
//    在 IPC 侧修过的是同一个 bug，那边 drawing.save 推的是 `content`，
//    AI 路径漏了。少推一个 scope 的症状都是「文件在磁盘上、UI 不更新」，
//    所以这里对绘图工具断言**集合**而不是单个值。
//
// mutatingScopes 从 ai-handlers 导出：它曾经是私有的，而「case miss 就
// 静默不刷新」正是这个函数的历史伤（早期用点号工具名 `todo.create`，
// 全部退化成不广播）。锁在这里，下一个加工具的人能立刻看见漏配的后果。

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '.', getAppPath: () => '.' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mutatingScopes } from '../../src/main/ipc/ai-handlers';

describe('mutatingScopes —— 绘图工具的作用域扇出', () => {
  it('drawing_save 同时推 drawings + content', () => {
    const scopes = mutatingScopes('drawing_save');
    expect(scopes).toContain('drawings'); // 绘图列表 + 打开中的画布场景
    expect(scopes).toContain('content'); // tab 列表（扫任务目录）
  });

  it('drawing_delete / drawing_setThumb 同样两个都要推', () => {
    // 删除会改变目录里的文件集合（tab 要少一个），setThumb 会改变列表项上
    // 的缩略图 —— 两者都不是「只有 drawings 订阅方」的单 scope 改动。
    expect(mutatingScopes('drawing_delete')).toEqual(
      expect.arrayContaining(['drawings', 'content']),
    );
    expect(mutatingScopes('drawing_setThumb')).toEqual(
      expect.arrayContaining(['drawings', 'content']),
    );
  });

  it('绘图工具不会误推 todos（否则左栏会被无关刷新）', () => {
    expect(mutatingScopes('drawing_save')).not.toContain('todos');
  });

  it('todo_* 工具仍然只推 todos', () => {
    // 这一组是纯 DB 改动，不碰文件集合，别顺手把 content/drawings 也带上。
    for (const name of ['todo_create', 'todo_update', 'todo_delete', 'todo_batchUpdate']) {
      expect(mutatingScopes(name)).toEqual(['todos']);
    }
  });

  it('content_* 工具仍然只推 content', () => {
    expect(mutatingScopes('content_writeBody')).toEqual(['content']);
    expect(mutatingScopes('content_restoreVersion')).toEqual(['content']);
  });

  it('工具名必须是下划线形式 —— 点号名一律不推（历史事故）', () => {
    // 早期 registerDomainTools 用点号，这里的 case 全 miss，于是所有 AI
    // 改动都静默地不广播，左栏不刷新。加工具时务必用 registerDomainTools
    // 里注册的那个名字。
    expect(mutatingScopes('todo.create')).toEqual([]);
    expect(mutatingScopes('drawing.save')).toEqual([]);
    expect(mutatingScopes('content.writeBody')).toEqual([]);
  });

  it('DSH 自带的 fs / shell 工具不推任何 scope', () => {
    // 它们改的是 dsh_workspace 下的文件，不在我们的 store 里。
    for (const name of ['read', 'write', 'edit', 'bash', 'pwsh', 'grep', 'glob']) {
      expect(mutatingScopes(name)).toEqual([]);
    }
  });

  it('未知工具返回空数组（调用方会退化成 todos 兜底广播）', () => {
    expect(mutatingScopes('some_future_tool')).toEqual([]);
  });

  it('永远返回数组，调用方不用判 null', () => {
    // 旧签名是 `DataScope | null`，改成数组后每个分支都得是可迭代的 ——
    // 返回 null 会让广播循环直接抛异常。
    for (const name of ['todo_create', 'drawing_save', 'read', 'unknown_thing']) {
      expect(Array.isArray(mutatingScopes(name))).toBe(true);
    }
  });
});
