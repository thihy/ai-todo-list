// @vitest-environment happy-dom
//
// 新建任务时「加入今日待办」的默认值随当前视图变化 —— 回归测试。
//
// 背景：用户从 Sidebar 切到「今日待办」再点「新建任务」，表单里的
// 「加入今日待办」复选框过去恒为不勾选（Composer 硬编码 false）。于是
// 在今日视图新建的任务并不会真的进今日分组，还得再点一次行尾的
// 「加入今日」—— 违背了"在哪个视图新建就归哪个视图"的直觉。
//
// 现在 App 把当前 listFilter 透传给 Composer，Composer 用它初始化
// 复选框：today 视图默认勾选，其余（non-today / all / 归档 / 已删除 /
// 按状态筛选）默认不勾选。注意这只是**默认值**，用户仍可手动改。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '../../src/renderer/components/Composer';

let container: HTMLDivElement;
let root: Root | null = null;
const created: Record<string, unknown>[] = [];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  created.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (window as unknown as { todoList: unknown }).todoList = {
    todo: {
      create: vi.fn().mockImplementation(async (payload: Record<string, unknown>) => {
        created.push(payload);
        return { ok: true, data: { id: 'new-id' } };
      }),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

function openComposer(defaultPlannedToday?: boolean) {
  act(() => {
    root!.render(
      <Composer
        onClose={() => {}}
        navigate={() => {}}
        {...(defaultPlannedToday === undefined ? {} : { defaultPlannedToday })}
      />,
    );
  });
  const checkbox = container.querySelector(
    '.composer__today input[type="checkbox"]',
  ) as HTMLInputElement;
  return checkbox;
}

describe('Composer「加入今日待办」默认值', () => {
  it('今日视图传入 true → 默认勾选', () => {
    expect(openComposer(true).checked).toBe(true);
  });

  it('后续待办 / 全部视图传入 false → 默认不勾选', () => {
    expect(openComposer(false).checked).toBe(false);
  });

  it('未传该属性时保持旧行为（不勾选）', () => {
    expect(openComposer(undefined).checked).toBe(false);
  });

  it('首帧就是勾选态，不闪回未勾选', () => {
    // 用惰性初始化而非 useEffect 回填，正是为了避免这个：
    // effect 方案首帧会是 false，再异步翻成 true，用户能看到一次跳变。
    const cb = openComposer(true);
    expect(cb.checked).toBe(true);
  });

  it('用户手动取消勾选后，提交时不写 plannedFor', async () => {
    const cb = openComposer(true);
    expect(cb.checked).toBe(true);

    // 用户反悔 —— 取消勾选。
    // 受控 checkbox 不响应直接赋值 .checked，必须走原生 setter + click，
    // React 的 onChange 才会触发（直接赋值只会被下一次 render 覆盖回去）。
    act(() => {
      const cbSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'checked',
      )!.set!;
      cbSetter.call(cb, false);
      cb.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(cb.checked).toBe(false);

    const title = container.querySelector(
      'input[placeholder="输入要完成的事项"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(title, '手动取消勾选的任务');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.composer__send')!.click();
      await Promise.resolve();
    });

    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('plannedFor');
  });

  it('默认勾选时，提交会写入今天的 plannedFor', async () => {
    openComposer(true);

    const title = container.querySelector(
      'input[placeholder="输入要完成的事项"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(title, '今日默认加入的任务');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.composer__send')!.click();
      await Promise.resolve();
    });

    expect(created).toHaveLength(1);
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    expect(created[0]).toHaveProperty('plannedFor', expected);
  });
});
