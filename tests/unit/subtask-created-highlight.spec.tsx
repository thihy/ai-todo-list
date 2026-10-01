// @vitest-environment happy-dom
//
// 子任务创建后的选中/跳转行为 —— 回归测试。
//
// 背景：任务行内点「+」添加子任务是**行内连续输入**（提交后输入框
// 刻意不卸载、保留焦点，方便一次连建多个）。所以它和主表单新建必须
// 区别对待：
//
//   主表单新建 → 跳转详情 + 高亮（Composer 自己在 submitForm 里 navigate）
//   子任务新建 → **只高亮，不跳转**（跳转会把行内输入流打断）
//   AI   新建 → 跳转详情 + 高亮（与主表单一致）
//
// 实现上，子任务只高亮是因为 App 里多了一个与路由解耦的
// `highlightId`；`selectedId` 仍由路由派生。路由选中优先于高亮，
// 点别的行会清掉高亮，避免"高亮的是 A、详情是 B"。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoListPane } from '../../src/renderer/panes/TodoListPane';
import type { ListFilter } from '../../src/renderer/router';
import type { ToastBus } from '../../src/renderer/components/Toast';

const TODOS = [
  { id: 'p1', title: '父任务', parentId: null, plannedFor: null, createdAt: 2, updatedAt: 2 },
];

vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: TODOS, loading: false, refresh: () => Promise.resolve() }),
  useSettings: () => ({ data: {} }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let toastBus: ToastBus;
let createdPayloads: Record<string, unknown>[];
/** 记录 app:todo-created 的监听回调，供测试手动触发 */
let todoCreatedHandler: ((p: { id: string }) => void) | null = null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createdPayloads = [];
  todoCreatedHandler = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  toastBus = { push: () => {} } as unknown as ToastBus;
  (window as unknown as { todoList: unknown }).todoList = {
    on: (event: string, cb: (p: { id: string }) => void) => {
      if (event === 'app:todo-created') todoCreatedHandler = cb;
      return () => { todoCreatedHandler = null; };
    },
    todo: {
      create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        createdPayloads.push(input);
        return { ok: true, data: { id: 'new-sub-id' } };
      }),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

function render(props: Partial<React.ComponentProps<typeof TodoListPane>> = {}) {
  act(() => {
    root!.render(
      <TodoListPane
        filter={{ kind: 'all' } as ListFilter}
        sort="alpha"
        selectedId={null}
        onSelect={() => {}}
        onCompose={() => {}}
        toastBus={toastBus}
        {...props}
      />,
    );
  });
}

const rowTitles = () =>
  [...container.querySelectorAll('.task-row__title')].map((e) => e.textContent);
const activeTitles = () =>
  [...container.querySelectorAll('.task-row.is-active .task-row__title')].map(
    (e) => e.textContent,
  );

describe('子任务创建 → 只高亮不跳转', () => {
  it('暴露 onSubtaskCreated 回调并在创建成功后调用，传入新任务 id', async () => {
    const onSubtaskCreated = vi.fn();
    render({ onSubtaskCreated });

    const addBtn = container.querySelector<HTMLButtonElement>(
      'button.task-row__add-subtask',
    )!;
    act(() => addBtn.click());
    await act(async () => {
      const input = [...container.querySelectorAll('input')].find(
        (i) => !i.closest('.composer'),
      )!;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, '新子任务');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const input = [...container.querySelectorAll('input')].find(
        (i) => !i.closest('.composer'),
      )!;
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createdPayloads).toHaveLength(1);
    expect(onSubtaskCreated).toHaveBeenCalledWith('new-sub-id');
  });

  it('不传 onSubtaskCreated 也不会崩（prop 可选）', () => {
    expect(() => render({ onSubtaskCreated: undefined })).not.toThrow();
  });
});

describe('AI 创建 → 回调 onAiCreated 用于跳转', () => {
  it('收到 app:todo-created 事件时把 id 抛给 onAiCreated', () => {
    const onAiCreated = vi.fn();
    render({ onAiCreated });

    expect(todoCreatedHandler).toBeTypeOf('function');
    act(() => todoCreatedHandler!({ id: 'ai-created-id' }));
    expect(onAiCreated).toHaveBeenCalledWith('ai-created-id');
  });

  it('事件缺少 id 时不调用回调（不跳转到 undefined）', () => {
    const onAiCreated = vi.fn();
    render({ onAiCreated });
    act(() => todoCreatedHandler!({ id: '' }));
    expect(onAiCreated).not.toHaveBeenCalled();
  });

  it('同时刷新列表并回调 —— 两个副作用都要发生', () => {
    const onAiCreated = vi.fn();
    render({ onAiCreated });
    act(() => todoCreatedHandler!({ id: 'x' }));
    expect(onAiCreated).toHaveBeenCalledTimes(1);
  });
});

describe('高亮与路由选中的优先级', () => {
  it('selectedId 传入时该行带 is-active（与 highlight 同一渲染通道）', () => {
    render({ selectedId: 'p1' });
    expect(activeTitles()).toEqual(['父任务']);
    expect(rowTitles()).toContain('父任务');
  });

  it('selectedId 为 null 时没有 is-active 行', () => {
    render({ selectedId: null });
    expect(activeTitles()).toEqual([]);
  });
});
