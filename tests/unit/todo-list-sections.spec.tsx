// @vitest-environment happy-dom
//
// 各视图下任务列表显示哪些 section —— 回归测试。
//
// 背景：Sidebar 提供 今日 / 非今日 / 全部 三个切换入口。最初「全部」
// 视图下三个 section（今日待办 / 后续待办 / 全部待办）会同时出现，于是
// 同一条任务在「今日待办」或「后续待办」里出现过一次，又在「全部待办」
// 里再出现一次 —— 完整列表被按今日/非今日拆开重复呈现，计数也对不上
// （实测 17 个根任务被拆成 2 + 15）。用户要求「全部」只显示「全部待办」。
//
// 这里锁死每个视图的 section 组合，锁的是"恰好一个 section"这个契约：
// 多渲染任何一个 section 都会让断言失败，避免以后又被改回三段式。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoListPane } from '../../src/renderer/panes/TodoListPane';
import type { ListFilter } from '../../src/renderer/router';
import type { ToastBus } from '../../src/renderer/components/Toast';

// 构造一组覆盖三种分组的任务：2 个今日（plannedFor = 今天）+ 3 个非今日，
// 外加一个子任务，让「全部」视图下的树真的有多层。
const TODAY = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const TODOS = [
  { id: 't1', title: '今日 A', parentId: null, plannedFor: TODAY, createdAt: 5, updatedAt: 5 },
  { id: 't2', title: '今日 B', parentId: null, plannedFor: TODAY, createdAt: 4, updatedAt: 4 },
  { id: 'n1', title: '后续 A', parentId: null, plannedFor: null, createdAt: 3, updatedAt: 3 },
  { id: 'n2', title: '后续 B', parentId: null, plannedFor: null, createdAt: 2, updatedAt: 2 },
  { id: 'n3', title: '后续 C', parentId: null, plannedFor: null, createdAt: 1, updatedAt: 1 },
  { id: 's1', title: '子任务', parentId: 'n1', plannedFor: null, createdAt: 6, updatedAt: 6 },
];

// 覆盖 useTodos：TodoListPane 走的是 repoFilter（这里各视图都返回 {}），
// 所以统一喂同一份数据，让 section 之间的差异纯粹来自渲染条件。
vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: TODOS, loading: false, refresh: () => Promise.resolve() }),
  useSettings: () => ({ data: { taskAppearance: undefined } }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let toastBus: ToastBus;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  toastBus = { push: () => {} } as unknown as ToastBus;
  (window as unknown as { todoList: unknown }).todoList = {
    on: () => () => {},
    todo: {
      list: vi.fn().mockResolvedValue({ ok: true, data: TODOS }),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(), restore: vi.fn(),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

function renderWith(filter: ListFilter) {
  act(() => {
    root!.render(
      <TodoListPane
        filter={filter}
        sort="alpha"
        selectedId={null}
        onSelect={() => {}}
        onCompose={() => {}}
        toastBus={toastBus}
      />,
    );
  });
}

/** 可见的 section 标题，按 DOM 顺序。 */
const sectionTitles = () =>
  [...container.querySelectorAll(
    '.planned-section__title, .non-today-section__title, .other-section__title',
  )].map((e) => e.textContent);

describe('TodoListPane 视图 → section 组合', () => {
  it('「全部」只显示「全部待办」，不显示今日/后续分组', () => {
    renderWith({ kind: 'all' });
    expect(sectionTitles()).toEqual(['全部待办']);
  });

  it('「全部」下每个根任务只出现一次（不再被拆成 2 + 3 重复）', () => {
    renderWith({ kind: 'all' });
    // 5 个根任务（t1/t2/n1/n2/n3），子任务 s1 嵌在 n1 下，不占根位。
    const roots = container.querySelectorAll('.other-section__list > li');
    expect(roots).toHaveLength(5);
    expect(container.querySelector('.planned-section')).toBeNull();
    expect(container.querySelector('.non-today-section')).toBeNull();
  });

  it('「今日」只显示「今日待办」', () => {
    renderWith({ kind: 'today' });
    expect(sectionTitles()).toEqual(['今日待办']);
  });

  it('「后续待办」只显示「后续待办」', () => {
    renderWith({ kind: 'non-today' });
    expect(sectionTitles()).toEqual(['后续待办']);
  });

  it('任一视图都恰好渲染一个 section', () => {
    for (const kind of ['all', 'today', 'non-today'] as const) {
      renderWith({ kind } as ListFilter);
      expect(sectionTitles()).toHaveLength(1);
    }
  });

  it('「全部」下子任务仍跟随父任务嵌套展示', () => {
    renderWith({ kind: 'all' });
    // s1 挂在 n1 下 → 出现在 n1 的子列表里，而不是顶层。
    const nested = container.querySelectorAll('.other-section__list ul li');
    expect(nested.length).toBeGreaterThan(0);
  });
});
