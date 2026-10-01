// @vitest-environment happy-dom
//
// 任务列表分组不可折叠 —— 回归测试。
//
// 背景：「今日待办 / 后续待办 / 全部待办」这三个视图本来就由 Sidebar 的
// 三个入口切换，列表内又给每个 section 配了一套折叠按钮，是**对同一件事
// 做两次控制**。折叠比 Sidebar 切换更糟：用户能点掉自己唯一的内容区，
// 却看不到任何"为什么变空了"的线索 —— Sidebar 上那个入口仍然是激活态，
// 看起来像是应用出问题了。
//
// 所以 section header 现在是静态的：不是 button、没有 onClick、没有
// aria-expanded，也没有 chevron。

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

const TODOS = [
  { id: 't1', title: '今日 A', parentId: null, plannedFor: TODAY, createdAt: 2, updatedAt: 2 },
  { id: 'n1', title: '后续 A', parentId: null, plannedFor: null, createdAt: 1, updatedAt: 1 },
];

vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: TODOS, loading: false, refresh: () => Promise.resolve() }),
  useSettings: () => ({ data: {} }),
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

const render = (filter: ListFilter) => {
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
};

const headers = () =>
  [...container.querySelectorAll(
    '.planned-section__header, .non-today-section__header, .other-section__header',
  )];

describe('任务列表分组标题不可折叠', () => {
  it('header 不是 <button>，没有 section-toggle 类', () => {
    render({ kind: 'all' } as ListFilter);
    expect(headers()).toHaveLength(1);
    for (const h of headers()) {
      expect(h.tagName).not.toBe('BUTTON');
      expect(h.className).not.toContain('section-toggle');
    }
  });

  it('header 不带 aria-expanded / aria-controls（不再是折叠开关）', () => {
    render({ kind: 'all' } as ListFilter);
    for (const h of headers()) {
      expect(h.hasAttribute('aria-expanded')).toBe(false);
      expect(h.hasAttribute('aria-controls')).toBe(false);
    }
  });

  it('没有渲染 chevron 图标', () => {
    render({ kind: 'all' } as ListFilter);
    expect(container.querySelector('.section-toggle__chevron')).toBeNull();
  });

  it('内容容器不带 is-collapsed，永远展开', () => {
    render({ kind: 'all' } as ListFilter);
    const wraps = [...container.querySelectorAll('.section-collapse')];
    expect(wraps.length).toBeGreaterThan(0);
    for (const w of wraps) {
      expect(w.classList.contains('is-collapsed')).toBe(false);
      expect(w.hasAttribute('aria-hidden')).toBe(false);
    }
  });

  it('点击 header 不会隐藏任何任务（无 onClick 可挂）', () => {
    render({ kind: 'all' } as ListFilter);
    const before = container.querySelectorAll('.task-row').length;
    expect(before).toBeGreaterThan(0);
    for (const h of headers()) h.click();
    expect(container.querySelectorAll('.task-row').length).toBe(before);
  });

  it('三个视图下 header 数量都恒为 1，且都不可折叠', () => {
    for (const kind of ['all', 'today', 'non-today'] as const) {
      render({ kind } as ListFilter);
      expect(headers()).toHaveLength(1);
      expect(headers()[0].tagName).not.toBe('BUTTON');
    }
  });
});
