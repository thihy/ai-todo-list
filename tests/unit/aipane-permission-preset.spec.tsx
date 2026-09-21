// @vitest-environment happy-dom
//
// AIPane 的权限预设选择器 —— 用户报「在 AI 助手里看不到审批模式的选项」，
// 这个测试锁住那个可见性契约本身。
//
// 覆盖：
//   - DSH 报出选项表时，选择器渲染在标题栏，显示当前预设名
//   - 打开菜单列出全部选项，当前项标记 aria-selected
//   - 选普通预设：直接 set，不弹确认
//   - 选 danger-full-access：**先弹确认**，取消则不 set
//   - options 为空（插件没挂载）→ 整个控件不渲染
//   - aiPermissionPreset 命名空间缺失（旧渲染端）→ 不渲染，也不抛

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  appListeners: new Map<string, (request: unknown) => void>(),
  composer: null as null | { onChange(text: string): void; onSubmit(): void; onStop(): void; busy: boolean },
  follow: { showJumpToLatest: false, jumpToLatest: () => {}, requestFollow: () => {} },
}));

vi.mock('../../src/renderer/hooks/useTodoListApi', async () => {
  const react = await import('react');
  return {
    useAiStream: () => ({ events: [], clear: () => {} }),
    useAppEvent: (name: string, handler: (value: unknown) => void) => react.useEffect(() => {
      harness.appListeners.set(name, handler);
      return () => { harness.appListeners.delete(name); };
    }, [name, handler]),
    useProviderStatus: () => ({ state: 'ready' }),
    useSettings: () => ({ data: { provider: 'deepseek', model: 'test' } }),
    useStartupAiState: () => ({ state: { status: 'ready' }, retry: vi.fn() }),
  };
});
vi.mock('../../src/renderer/hooks/useChatAutoFollow', () => ({ useChatAutoFollow: () => harness.follow }));
vi.mock('../../src/renderer/data-bus', () => ({ useDataVersion: () => 0 }));
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconEnhanceOutline16: () => null, IconPlusOutline16: () => null,
  IconPaperclipOutline16: () => null, IconWarningOutline16: () => null,
  IconChevronDownOutline14: () => null, Button: () => null,
}));
vi.mock('../../src/renderer/components/icons', () => ({ IconHistory: () => null, IconCollapseBar: () => null }));
vi.mock('../../src/renderer/components/Composer', () => ({ AI_SUBMIT_EVENT: 'test:submit' }));
vi.mock('../../src/renderer/dsh/AIComposer', async () => {
  const react = await import('react');
  return { AIComposer: react.forwardRef((props: NonNullable<typeof harness.composer>, _ref) => {
    harness.composer = props;
    return null;
  }) };
});
vi.mock('../../src/renderer/dsh/PendingQuestionCard', () => ({ PendingQuestionCard: () => null }));
vi.mock('../../src/renderer/dsh/PendingApprovalCard', () => ({ PendingApprovalCard: () => null }));
vi.mock('../../src/renderer/components/AiCreateTaskMessage', () => ({ AiCreateTaskMessage: () => null }));
vi.mock('../../src/renderer/dsh/AssistantTurnContent', async () => {
  const react = await import('react');
  return { AssistantTurnContent: () => react.createElement('output', null, '') };
});

import { AIPane } from '../../src/renderer/panes/AIPane';

// OPTIONS 跟 resources/dsh/cordis.yml 里的 name/description 一一对应 ——
// UI 显示的就是这两字段，不是 raw value（key）。同步过来以后测试断言的
// "Auto" / "完全访问" 这些字符串跟真机一致，回归才会被发现。
const OPTIONS = [
  { value: 'read-only', name: '只读', description: '只能读取文件，任何写入或命令执行都要逐次审批。' },
  { value: 'workspace-write', name: '工作区可写', description: '可在工作区内读写文件，越界操作逐次审批。' },
  { value: 'auto', name: 'Auto', description: '工作区内自动执行；越界访问自动审查并一次性审批。' },
  { value: 'danger-full-access', name: '完全访问', description: '关闭沙箱且不再审批 —— AI 可执行任意命令，请谨慎使用。' },
];

let root: Root;
let container: HTMLDivElement;
let get: ReturnType<typeof vi.fn>;
let set: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;

/** 挂载 AIPane，等预设 IPC 的 promise 落定。
 *
 *  `conversations: []` 模拟 draft 状态：没有活跃会话（currentId=null）。
 *  注意 AIPane 在列表非空时会自动选中第一行，所以必须传空列表才能拿到
 *  draft —— 只把 currentId 置空是做不到的。 */
async function mount(opts: {
  options?: typeof OPTIONS;
  effective?: string;
  conversations?: Array<{ id: string; title: string; updatedAt: number; archived: boolean }>;
} = {}) {
  const options = opts.options ?? OPTIONS;
  const list = opts.conversations ?? [
    { id: 'conv', title: 'test', updatedAt: 0, archived: false },
  ];
  get = vi.fn().mockImplementation((req?: { conversationId?: string }) => {
    // 无会话（draft）：只回选项表 + 默认值，stored/current 都是 null。
    if (!req?.conversationId) {
      return Promise.resolve({
        ok: true,
        data: {
          current: null, stored: null, effective: 'auto',
          defaultPreset: 'auto', options,
        },
      });
    }
    return Promise.resolve({
      ok: true,
      data: {
        current: 'auto', stored: opts.effective ?? 'auto',
        effective: opts.effective ?? 'auto', defaultPreset: 'auto',
        options,
      },
    });
  });
  // 回显请求的 preset：UI 用 stored 做乐观更新，桩返回固定值会掩盖 bug。
  set = vi.fn().mockImplementation((req: { preset: string }) =>
    Promise.resolve({ ok: true, data: { stored: req.preset, applied: true } }));
  confirm = vi.fn().mockResolvedValue({ ok: true, data: { confirmed: true } });

  window.todoList = {
    ai: { ask: vi.fn(), cancel: vi.fn().mockResolvedValue({ ok: true }) },
    conversation: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { conversations: list, total: list.length, remaining: 0 } }),
      history: vi.fn().mockResolvedValue({ ok: true, data: { turns: [] } }),
      create: vi.fn().mockResolvedValue({
        ok: true,
        data: { conversation: { id: 'new-conv', title: '新对话', updatedAt: 1, archived: false } },
      }),
    },
    aiPermissionPreset: { get, set, confirm },
  } as unknown as typeof window.todoList;

  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(AIPane)); });
  // 让 get() 的 promise 落定
  await act(async () => { await Promise.resolve(); });
}

function presetButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.aipane__preset-btn');
}
function menuItems(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.aipane__preset-item'));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  harness.appListeners.clear();
});

describe('AIPane 权限预设选择器', () => {
  it('DSH 报出选项表时渲染在标题栏，显示当前预设名', async () => {
    await mount();
    const btn = presetButton();
    expect(btn).not.toBeNull();
    // 显示的是 name 而不是 raw value
    expect(btn!.textContent).toContain('Auto');
    expect(btn!.getAttribute('aria-expanded')).toBe('false');
    // 菜单默认收起
    expect(menuItems()).toHaveLength(0);
  });

  it('点击展开菜单，列出全部选项并标记当前项', async () => {
    await mount();
    await act(async () => { presetButton()!.click(); });
    const items = menuItems();
    expect(items).toHaveLength(4);
    expect(items.map((b) => b.textContent)).toEqual([
      '只读只能读取文件，任何写入或命令执行都要逐次审批。',
      '工作区可写可在工作区内读写文件，越界操作逐次审批。',
      'Auto工作区内自动执行；越界访问自动审查并一次性审批。',
      '完全访问关闭沙箱且不再审批 —— AI 可执行任意命令，请谨慎使用。',
    ]);
    // 当前项 aria-selected=true，其余 false
    expect(items.map((b) => b.getAttribute('aria-selected'))).toEqual(
      ['false', 'false', 'true', 'false'],
    );
  });

  it('选普通预设直接 set，不弹确认', async () => {
    await mount();
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[0]!.click(); });
    expect(confirm).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({ conversationId: 'conv', preset: 'read-only' });
    // 选完自动收起
    expect(menuItems()).toHaveLength(0);
    // 乐观更新：标签换成新预设名
    expect(presetButton()!.textContent).toContain('只读');
  });

  it('选 danger-full-access 先弹确认，确认后才 set', async () => {
    await mount();
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[3]!.click(); });
    expect(confirm).toHaveBeenCalledWith({ preset: 'danger-full-access' });
    expect(set).toHaveBeenCalledWith({ conversationId: 'conv', preset: 'danger-full-access' });
  });

  it('danger-full-access 确认被取消时不 set，当前值不变', async () => {
    await mount();
    confirm.mockResolvedValue({ ok: true, data: { confirmed: false } });
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[3]!.click(); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
    // 取消 = 什么都没发生：菜单留在原地让用户改选别的，显示值仍是 auto。
    expect(menuItems()).toHaveLength(4);
    expect(presetButton()!.textContent).toContain('Auto');
    expect(presetButton()!.className).not.toContain('--danger');
  });

  it('options 为空（插件没挂载）→ 整个控件不渲染', async () => {
    await mount({ options: [] });
    expect(presetButton()).toBeNull();
    // 其它动作按钮仍在 —— 只是隐藏了选择器，没有连坐
    expect(container.querySelector('.aipane__new-btn')).not.toBeNull();
  });

  it('aiPermissionPreset 命名空间缺失（旧渲染端）→ 不渲染且不抛', async () => {
    await mount();
    // 拆掉命名空间再强制重挂载 —— 模拟部分测试桩 / 旧 preload
    delete (window.todoList as unknown as Record<string, unknown>).aiPermissionPreset;
    await act(async () => { root.unmount(); });
    container.remove();
    const conversation = { id: 'conv', title: 'test', updatedAt: 0, archived: false };
    window.todoList = {
      ai: { ask: vi.fn(), cancel: vi.fn().mockResolvedValue({ ok: true }) },
      conversation: {
        list: vi.fn().mockResolvedValue({ ok: true, data: { conversations: [conversation], total: 1, remaining: 0 } }),
        history: vi.fn().mockResolvedValue({ ok: true, data: { turns: [] } }),
      },
    } as unknown as typeof window.todoList;
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(AIPane)); });
    await act(async () => { await Promise.resolve(); });
    expect(presetButton()).toBeNull();
  });

  it('danger-full-access 生效时按钮带危险态类名', async () => {
    await mount({ effective: 'danger-full-access' });
    const btn = presetButton();
    expect(btn!.className).toContain('aipane__preset-btn--danger');
    expect(btn!.textContent).toContain('完全访问');
  });
});

// 新对话（draft）在首轮提交前没有 conversations 行 —— 但用户恰恰会想先
// 定好预设再发消息。这组测试锁住「draft 也能选」这条路径。
describe('AIPane 权限预设选择器 — 新对话（draft）', () => {
  const DRAFT = { conversations: [] as Array<{ id: string; title: string; updatedAt: number; archived: boolean }> };

  it('没有活跃会话时仍然渲染选择器，显示 defaultPreset', async () => {
    await mount(DRAFT);
    const btn = presetButton();
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Auto');
    // 无会话分支：get 收到的是空对象，不是 conversationId
    expect(get).toHaveBeenCalledWith({});
  });

  it('draft 里选预设不调 set（还没行可写），但标签立即更新', async () => {
    await mount(DRAFT);
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[0]!.click(); });
    expect(set).not.toHaveBeenCalled();
    expect(presetButton()!.textContent).toContain('只读');
    // 菜单收起
    expect(menuItems()).toHaveLength(0);
  });

  it('draft 里选 danger-full-access 仍要过二次确认', async () => {
    await mount(DRAFT);
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[3]!.click(); });
    expect(confirm).toHaveBeenCalledWith({ preset: 'danger-full-access' });
    expect(presetButton()!.textContent).toContain('完全访问');
  });

  it('draft 里选 danger-full-access 被取消则不记，标签不变', async () => {
    await mount(DRAFT);
    confirm.mockResolvedValue({ ok: true, data: { confirmed: false } });
    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[3]!.click(); });
    expect(presetButton()!.textContent).toContain('Auto');
  });

  it('提交首轮时先落库预设、再发起 ai.ask（顺序是承重的）', async () => {
    // 承重前提：main 侧 pinPermissionPreset() 在 ensureAgent() 里读 DB。
    // 若 ai.ask 先到，这次对话就按 defaultPreset 跑了，用户的选择白选。
    await mount(DRAFT);
    const order: string[] = [];
    set.mockImplementation((req: { preset: string }) => {
      order.push('set');
      return Promise.resolve({ ok: true, data: { stored: req.preset, applied: false } });
    });
    (window.todoList.ai as unknown as { ask: ReturnType<typeof vi.fn> }).ask = vi.fn(() => {
      order.push('ask');
      return Promise.resolve({ ok: true, data: { invocationId: 'inv-1' } });
    });

    await act(async () => { presetButton()!.click(); });
    await act(async () => { menuItems()[0]!.click(); });
    expect(set).not.toHaveBeenCalled(); // draft 阶段只记本地

    // 发第一条消息 → 建行 → 补写预设 → 起轮。
    // onChange 走 React state，必须单独 flush 一次，否则 runSubmit 的闭包
    // 里还是旧的空 input，会被 `if (!prompt) return` 挡掉。
    await act(async () => { harness.composer!.onChange('hello'); });
    await act(async () => { harness.composer!.onSubmit(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(order).toEqual(['set', 'ask']);
    expect(set).toHaveBeenCalledWith({ conversationId: 'new-conv', preset: 'read-only' });
  });
});
