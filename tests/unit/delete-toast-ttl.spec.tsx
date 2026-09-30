// @vitest-environment happy-dom
//
// 删除待办后的悬浮提示时长 —— 回归测试。
//
// 背景：删除任务的 toast 原本挂 5 分钟（5 * 60_000）。这个 toast 是**
// 常驻可见**的浮层，锚在任务列表底部，5 分钟里一直杵着会挡住新行、也让
// 用户误以为应用卡住了。改成 30s：足够看清"删了哪条"并点「恢复」，超时
// 后任务仍在「已删除」视图里可找回，所以缩短是安全的。
//
// 这里锁的是 ttl 的**具体值**：改成别的时长（比如又调回 5 分钟，或短到
// 来不及点恢复）都会红。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoListPane } from '../../src/renderer/panes/TodoListPane';
import type { ListFilter } from '../../src/renderer/router';
import type { Toast, ToastBus } from '../../src/renderer/components/Toast';

const TODOS = [
  { id: 't1', title: '将被删除的任务', parentId: null, plannedFor: null, createdAt: 1, updatedAt: 1 },
];

vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: TODOS, loading: false, refresh: () => Promise.resolve() }),
  useSettings: () => ({ data: { taskAppearance: undefined } }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
/** 捕获 push 出来的 toast，供断言 ttl。 */
let pushed: Toast[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pushed = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (window as unknown as { todoList: unknown }).todoList = {
    on: () => () => {},
    todo: {
      list: vi.fn().mockResolvedValue({ ok: true, data: TODOS }),
      create: vi.fn(), update: vi.fn(),
      delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      restore: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

const toastBus = {
  push: (t: Toast) => { pushed.push(t); },
} as unknown as ToastBus;

function render() {
  act(() => {
    root!.render(
      <TodoListPane
        filter={{ kind: 'all' } as ListFilter}
        sort="alpha"
        selectedId={null}
        onSelect={() => {}}
        onCompose={() => {}}
        toastBus={toastBus}
      />,
    );
  });
}

async function deleteFirstTask() {
  render();
  const del = container.querySelector<HTMLButtonElement>('button.task-row__delete')!;
  await act(async () => {
    del.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('删除待办的 toast 时长', () => {
  it('ttl 为 30000ms（30 秒）', async () => {
    await deleteFirstTask();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].ttl).toBe(30_000);
  });

  it('不再是 5 分钟', async () => {
    await deleteFirstTask();
    expect(pushed[0].ttl).not.toBe(5 * 60_000);
  });

  it('仍带「恢复」动作 —— 缩短时长不能牺牲可撤销性', async () => {
    await deleteFirstTask();
    expect(pushed[0].action?.label).toBe('恢复');
    expect(pushed[0].action?.run).toBeTypeOf('function');
  });

  it('消息里包含被删任务标题', async () => {
    await deleteFirstTask();
    expect(pushed[0].message).toContain('将被删除的任务');
  });

  it('ttl 为正数（不会变成 sticky 永不消失）', async () => {
    await deleteFirstTask();
    expect(pushed[0].ttl).toBeGreaterThan(0);
  });
});
