// @vitest-environment happy-dom
//
// 各视图为空时的空态 —— 回归测试。
//
// 背景：Sidebar 的「今日 / 非今日 / 全部」三个视图在 repo 层都取**全量**
// active 任务（filterToRepoFilter 对三者都返回 {}），真正的分桶发生在
// 渲染层：每个 section 都要求"本视图的行数 > 0"才渲染。
//
// 于是旧空态条件 `data.length === 0` 永远抓不到"本视图为空"：库里明明有
// 任务（data.length > 0），但切到「今日」时没有任何一条 plannedFor 等于
// 今天，三个 section 又都不满足渲染条件 —— 结果是一整片纯空白。用户既
// 看不到"今天确实没安排"，也没有下一步该点哪里，看起来像应用坏了。
//
// 这里锁死的是"本视图为空 → 必须有解释 + 行动入口"，具体断言：
//   - 今日为空显示「今天没有待办」和「添加今日待办」按钮；
//   - 点该按钮真的调 onCompose（Composer 会因 defaultPlannedToday 自动
//     勾选「加入今日待办」，新建任务直接落在这个视图里）；
//   - 非今日为空、全部为空各有自己的文案，不会串；
//   - 非空视图绝不误报空态（否则会在有内容时插入一个假空态）。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoListPane } from '../../src/renderer/panes/TodoListPane';
import type { ListFilter } from '../../src/renderer/router';
import type { ToastBus } from '../../src/renderer/components/Toast';

const TODAY = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

type Todo = {
  id: string;
  title: string;
  parentId: string | null;
  plannedFor: string | null;
  createdAt: number;
  updatedAt: number;
};

// 今日有 2 条 + 后续有 2 条 —— 三个视图各自都有货。
const BOTH: Todo[] = [
  { id: 't1', title: '今日 A', parentId: null, plannedFor: TODAY, createdAt: 5, updatedAt: 5 },
  { id: 't2', title: '今日 B', parentId: null, plannedFor: TODAY, createdAt: 4, updatedAt: 4 },
  { id: 'n1', title: '后续 A', parentId: null, plannedFor: null, createdAt: 3, updatedAt: 3 },
  { id: 'n2', title: '后续 B', parentId: null, plannedFor: null, createdAt: 2, updatedAt: 2 },
];

// 只有非今日任务 → 「今日」视图为空，但 data.length > 0，正是原来的空白场景。
const ONLY_FUTURE: Todo[] = [
  { id: 'n1', title: '后续 A', parentId: null, plannedFor: null, createdAt: 3, updatedAt: 3 },
  { id: 'n2', title: '后续 B', parentId: null, plannedFor: null, createdAt: 2, updatedAt: 2 },
];

// 只有今日任务 → 「非今日」视图为空。
const ONLY_TODAY: Todo[] = [
  { id: 't1', title: '今日 A', parentId: null, plannedFor: TODAY, createdAt: 5, updatedAt: 5 },
];

// mock 的 useTodos 读这个可变列表，各 it 自行替换。
let todos: Todo[] = BOTH;

vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: todos, loading: false, refresh: () => Promise.resolve() }),
  useSettings: () => ({ data: {} }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let toastBus: ToastBus;
let onCompose: () => void;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  todos = BOTH;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  toastBus = { push: () => {} } as unknown as ToastBus;
  onCompose = vi.fn();
  (window as unknown as { todoList: unknown }).todoList = {
    on: () => () => {},
    todo: {
      list: vi.fn().mockResolvedValue({ ok: true, data: todos }),
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
        onCompose={onCompose}
        toastBus={toastBus}
      />,
    );
  });
}

/** 视图级空态元素（视图专属文案 + 行动按钮那一个）。 */
const viewEmptyEl = () => container.querySelector('.task-list__empty');
const viewEmptyText = () => viewEmptyEl()?.textContent ?? '';
/** 空态里的主行动按钮 —— 区分于 header 里那个「新建任务」。 */
const emptyAction = () =>
  container.querySelector<HTMLButtonElement>('.task-list__empty-action');
const sectionTitles = () =>
  [...container.querySelectorAll(
    '.planned-section__title, .non-today-section__title, .other-section__title',
  )].map((e) => e.textContent);

describe('TodoListPane 视图级空态', () => {
  it('「今日」为空时显示空态文案，而不是一片空白', () => {
    todos = ONLY_FUTURE;
    renderWith({ kind: 'today' });
    // 关键回归点：库里有 2 条任务，但没有任何一条属于今日 —— 旧代码这里渲染 0 个
    // 节点（纯空白），现在必须有可见的空态。
    expect(todos.length).toBeGreaterThan(0);
    expect(viewEmptyEl()).not.toBeNull();
    expect(viewEmptyText()).toContain('今天没有待办');
  });

  it('「今日」空态提供「添加今日待办」主行动，点击打开 Composer', () => {
    todos = ONLY_FUTURE;
    renderWith({ kind: 'today' });
    const btn = emptyAction();
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('添加今日待办');
    act(() => btn!.click());
    // Composer 在今日视图下带 defaultPlannedToday，新建即落在这个视图。
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('「后续待办」为空时显示自己的文案，不复用今日的', () => {
    todos = ONLY_TODAY;
    renderWith({ kind: 'non-today' });
    expect(viewEmptyEl()).not.toBeNull();
    expect(viewEmptyText()).toContain('没有后续待办');
    expect(viewEmptyText()).not.toContain('今天没有待办');
  });

  it('空态出现时不渲染任何 section（空态就是本视图的全部内容）', () => {
    todos = ONLY_FUTURE;
    renderWith({ kind: 'today' });
    expect(sectionTitles()).toHaveLength(0);
  });

  it('本视图有内容时不显示空态（不误报）', () => {
    todos = BOTH;
    for (const kind of ['today', 'non-today', 'all'] as const) {
      renderWith({ kind } as ListFilter);
      expect(viewEmptyEl(), `${kind} 视图有内容，不该有空态`).toBeNull();
    }
  });

  it('「全部」为空时显示空态而不是空白', () => {
    todos = [];
    renderWith({ kind: 'all' });
    expect(viewEmptyEl()).not.toBeNull();
    expect(viewEmptyText()).toContain('暂无任务');
  });

  it('空态里的行动按钮可点击并调用 onCompose（非今日视图）', () => {
    todos = ONLY_TODAY;
    renderWith({ kind: 'non-today' });
    const btn = emptyAction();
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onCompose).toHaveBeenCalledTimes(1);
  });
});
