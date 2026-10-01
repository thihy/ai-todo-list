// @vitest-environment happy-dom
//
// 任务列表列的拖拽调宽 —— 回归测试。
//
// 背景：引入 TaskListPanel 包裹任务列表列时，width 被加在了内层
// .task-list 上，而真正参与 .master-detail flex 布局的是外层
// .task-list-panel，且外层被写死 width: 340px + overflow: hidden。
// 结果 PaneDivider 拖拽时 React 状态一路在变，但内层在固定宽度容器里
// 伸缩、差值被裁掉 —— 屏幕完全没反应。这是**静默失效**：没有报错、没有
// 警告、state 也是对的，只有肉眼看不出区别，所以普通断言挡不住。
//
// 这里锁的是「宽度契约」本身，而不是某个具体数值：
//   1. 可变宽度必须落在直接父级（.task-list-panel），即 flex child 上；
//   2. 内层 .task-list 不得自带 width，只能 stretch；
//   3. TaskListPanel 必须把 width 透传到 DOM 的 inline style；
//   4. 拖拽回调的 delta 符号与 App 的接法（listWidth + dx）保持一致。
//
// 第 1、2 条正是 bug 的两个面：任何一条被改回去，第 1 个用例就会红。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskListPanel } from '../../src/renderer/layout/TaskListPanel';
import { PaneDivider } from '../../src/renderer/components/PaneDivider';
import { TodoListPane } from '../../src/renderer/panes/TodoListPane';
import type { ToastBus } from '../../src/renderer/components/Toast';

// TodoListPane 自己不发请求，全走 useTodos / useSettings；把这两个 hook
// 打桩掉，就能只关心它的 DOM 契约而不牵扯 IPC。
vi.mock('../../src/renderer/hooks/useTodoListApi', () => ({
  useTodos: () => ({ data: [], loading: false, refresh: () => Promise.resolve() }),
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
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(), restore: vi.fn(),
    },
  };
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

/** 模拟 App 的接线：state 存 listWidth，拖拽回调做 listWidth + dx。 */
function mountPanel(initialWidth: number): { setWidth: (w: number) => void; getWidth: () => number } {
  let width = initialWidth;
  const api = {
    setWidth: (w: number) => { width = w; },
    getWidth: () => width,
  };
  const Harness: React.FC = () => {
    const [w, setW] = React.useState(initialWidth);
    api.setWidth = (n: number) => setW(n);
    api.getWidth = () => w;
    return (
      // 结构与 App.tsx 的 master-detail 一致：panel 是 flex child，
      // divider 是它的兄弟，TodoListPane 挂在 panel 的 body 里。
      <div className="master-detail">
        <TaskListPanel width={w}>
          <section className="task-list">
            <div className="task-list__header" />
            <div className="task-list__body" />
          </section>
        </TaskListPanel>
        <PaneDivider onDrag={(dx) => setW((prev) => prev + dx)} />
      </div>
    );
  };
  act(() => { root!.render(React.createElement(Harness)); });
  return api;
}

function panel(): HTMLElement {
  return container.querySelector<HTMLElement>('.task-list-panel')!;
}
function list(): HTMLElement {
  return container.querySelector<HTMLElement>('.task-list')!;
}

/** 读 inline style 里显式声明的 width（px）。返回 null 表示没声明。 */
function inlineWidth(el: HTMLElement): string | null {
  const v = el.style.width;
  return v === '' ? null : v;
}

describe('TaskListPanel 列宽契约', () => {
  it('可变宽度落在 .task-list-panel（flex child）上，不在内层 .task-list 上', async () => {
    mountPanel(360);

    // 关键断言：宽度挂在直接父级上。
    expect(inlineWidth(panel())).toBe('360px');
    expect(inlineWidth(list())).toBeNull();

    // 内层只负责 stretch，不声明任何宽度。
    expect(list().style.flex).toBe('');
  });

  it('改宽度时同步更新 panel 的 inline width，list 始终不带 width', async () => {
    const api = mountPanel(360);

    await act(async () => { api.setWidth(520); });
    expect(inlineWidth(panel())).toBe('520px');
    expect(inlineWidth(list())).toBeNull();

    await act(async () => { api.setWidth(280); });
    expect(inlineWidth(panel())).toBe('280px');
    expect(inlineWidth(list())).toBeNull();
  });

  it('内层 .task-list 存在且挂在 panel 的 body 里（结构没被拆散）', async () => {
    mountPanel(360);
    const body = panel().querySelector('.task-list-panel__body');
    expect(body).not.toBeNull();
    expect(body!.querySelector('.task-list')).toBe(list());
  });
});

describe('真实 TodoListPane 不再自带宽度', () => {
  // 上面的用例用的是 stub 子节点，证明不了 TodoListPane 自己有没有偷偷
  // 把 width 写回 <section> —— 而那正是 bug 的另一半。这里挂真组件。
  async function mountReal(width: number): Promise<void> {
    const Harness: React.FC = () => (
      <TaskListPanel width={width}>
        <TodoListPane
          filter={{ kind: 'all' }}
          sort="alpha"
          selectedId={null}
          onSelect={() => {}}
          onCompose={() => {}}
          toastBus={toastBus}
        />
      </TaskListPanel>
    );
    await act(async () => { root!.render(React.createElement(Harness)); });
  }

  it('TodoListPane 的 <section> 没有 inline width，宽度只在 panel 上', async () => {
    await mountReal(360);
    const real = container.querySelector<HTMLElement>('.task-list')!;
    expect(real).not.toBeNull();
    // 回归点：曾经这里是 style={{ width }}，导致拖拽差值被外层裁掉。
    expect(inlineWidth(real)).toBeNull();
    expect(inlineWidth(panel())).toBe('360px');
  });

  it('TodoListPane 不再往 section 注入任何内联样式', async () => {
    await mountReal(360);
    const real = container.querySelector<HTMLElement>('.task-list')!;
    // 这里曾经断言 10 个 --task-prio-* 自定义属性还在（保护 taskListStyle 没被
    // 宽度改动误伤）。任务配色功能整条下线后，taskListStyle 已删除，section 不再
    // 持有任何内联样式 —— 保留一条"cssText 必须为空"的反向锁定：将来若有人又往
    // 这里塞内联宽度或内联配色，第一个用例的 inlineWidth(real) 会先炸。
    expect(real.style.cssText).toBe('');
  });

  it('TodoListPane 不接受 width prop（类型层面已移除，运行时也不该有）', async () => {
    await mountReal(360);
    // 反向锁定：TaskListPanel 的 width 变化不应传导到内层 section
    const before = container.querySelector<HTMLElement>('.task-list')!.style.cssText;
    await act(async () => { root!.render(
      React.createElement(TaskListPanel, { width: 500 },
        React.createElement(TodoListPane as never, {
          filter: { kind: 'all' }, sort: 'alpha', selectedId: null,
          onSelect: () => {}, onCompose: () => {}, toastBus,
        } as never),
      ),
    ); });
    const after = container.querySelector<HTMLElement>('.task-list')!.style.cssText;
    expect(after).toBe(before);
  });
});

describe('PaneDivider 拖拽接到列宽上', () => {
  /** 在分隔条上按下，然后派发一串 mousemove，最后 mouseup。 */
  async function drag(fromX: number, toX: number): Promise<void> {
    const divider = container.querySelector<HTMLElement>('.pane-divider')!;
    await act(async () => {
      divider.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: fromX }),
      );
    });
    // PaneDivider 把 move/up 挂在 window 上，模拟指针滑出分隔条。
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: toX }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: toX }));
    });
  }

  it('向右拖动列变宽，向左拖动列变窄', async () => {
    const api = mountPanel(360);

    await drag(400, 500); // dx = +100
    expect(api.getWidth()).toBe(460);
    expect(inlineWidth(panel())).toBe('460px');

    await drag(500, 420); // dx = -80
    expect(api.getWidth()).toBe(380);
    expect(inlineWidth(panel())).toBe('380px');
  });

  it('拖拽结束后 body 的 cursor / userSelect 被还原', async () => {
    mountPanel(360);
    await drag(400, 460);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('分隔条带 separator + 竖向方向的可访问性语义', async () => {
    mountPanel(360);
    const divider = container.querySelector('.pane-divider')!;
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-label')).toBe('拖动调整宽度');
  });
});
