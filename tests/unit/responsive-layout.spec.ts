// 响应式降级 —— 回归测试。
//
// 契约：窗口变窄时 AI 助手和任务列表自动折叠成 rail（不会消失），
// 变宽时反向恢复。顺序按"重要性递减"排：AI 是增强（没它任务照常用），
// 任务列表是主从布局的 master（主干的一部分），详情区永不折叠。
//
// AI 助手和任务列表都设计成"可折叠成 rail"的形态 —— 响应式自动折叠
// = 让面板进入折叠态，与手动折叠语义统一。
//
// 另一个容易写错的点：响应式不能覆盖用户意图。用户手动折叠的 AI 面板
// 不该因为窗口变宽就被自动展开 —— prefersAi=false 是持久偏好。

import { describe, expect, it } from 'vitest';

import {
  BREAKPOINT_AI,
  BREAKPOINT_LIST,
  computeResponsiveLayout,
} from '../../src/renderer/hooks/useResponsiveLayout';

describe('computeResponsiveLayout — 降级顺序', () => {
  it('宽度充足：两栏都展开', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI, true, true);
    expect(r).toEqual({ tier: 'full', aiOpen: true, listOpen: true });
  });

  it('低于 AI 断点：AI 自动折叠成 rail，任务列表仍展开', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI - 1, true, true);
    // AI 折叠 = 面板还在，只是 aiOpen=false（UI 渲染 rail）。
    expect(r.aiOpen).toBe(false);
    expect(r.listOpen).toBe(true);
    expect(r.tier).toBe('list');
  });

  it('低于列表断点：AI 和任务列表都自动折叠成 rail，只剩详情', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST - 1, true, true);
    expect(r.aiOpen).toBe(false);
    expect(r.listOpen).toBe(false);
    expect(r.tier).toBe('single');
  });

  it('降级顺序确实是「先 AI 后列表」—— 中间那段宽度 AI 折叠列表还在', () => {
    // 这条最容易在重构时被改成同时折叠，所以显式断言中间态。
    const mid = computeResponsiveLayout(BREAKPOINT_LIST + 1, true, true);
    expect(mid.aiOpen).toBe(false);
    expect(mid.listOpen).toBe(true);
  });
});

describe('computeResponsiveLayout — 恢复顺序（双向对称）', () => {
  it('从最窄逐级变宽：单栏 → 加任务列表 → 再加 AI', () => {
    const narrow = computeResponsiveLayout(700, true, true);
    expect(narrow.tier).toBe('single');
    expect(narrow.aiOpen).toBe(false);
    expect(narrow.listOpen).toBe(false);

    const mid = computeResponsiveLayout(900, true, true);
    expect(mid.tier).toBe('list');
    expect(mid.listOpen).toBe(true);
    expect(mid.aiOpen).toBe(false);

    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.tier).toBe('full');
    expect(wide.listOpen).toBe(true);
    expect(wide.aiOpen).toBe(true);
  });

  it('逐级变窄是逐级折叠：AI 先折叠，列表后折叠', () => {
    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.aiOpen && wide.listOpen).toBe(true);

    const mid = computeResponsiveLayout(1000, true, true);
    expect(mid.aiOpen).toBe(false);
    expect(mid.listOpen).toBe(true);

    const narrow = computeResponsiveLayout(700, true, true);
    expect(narrow.aiOpen).toBe(false);
    expect(narrow.listOpen).toBe(false);
  });
});

describe('computeResponsiveLayout — 尊重用户意图', () => {
  it('用户手动折叠了 AI：宽窗口下仍折叠', () => {
    const r = computeResponsiveLayout(1920, false, true);
    expect(r.aiOpen).toBe(false);
    expect(r.listOpen).toBe(true);
    // 用户主动关是持久偏好，响应式不能偷偷恢复。
  });

  it('用户手动折叠了任务列表：宽窗口下仍折叠', () => {
    const r = computeResponsiveLayout(1920, true, false);
    expect(r.aiOpen).toBe(true);
    expect(r.listOpen).toBe(false);
  });

  it('两个都手动折叠了：宽窗口下依然都折叠', () => {
    const r = computeResponsiveLayout(1920, false, false);
    expect(r.aiOpen).toBe(false);
    expect(r.listOpen).toBe(false);
  });

  it('用户已折叠的 AI 在窄窗口下也是折叠（不"打开"）', () => {
    const r = computeResponsiveLayout(700, false, true);
    expect(r.aiOpen).toBe(false);
    expect(r.listOpen).toBe(false);
  });
});

describe('computeResponsiveLayout — 自动折叠 = 折叠成 rail，不是消失', () => {
  it('AI 自动折叠时：面板的偏好仍然是"展开"（prefersAi 不被改）', () => {
    // 这是关键语义：响应式折叠只影响显示，不改偏好。pull 函数层面
    // 没有"autoCollapsed"这种状态 —— 折叠就是 aiOpen=false，与手动
    // 折叠的结果一致；UI 端不区分"自动"和"手动"，都渲染 rail。
    const r = computeResponsiveLayout(900, true, true);
    expect(r.aiOpen).toBe(false);
    // 没有 aiAutoCollapsed 字段 —— 已并入 aiOpen。
  });

  it('AI 自动折叠后窗口变宽：自动恢复（prefersAi 仍为 true）', () => {
    const narrow = computeResponsiveLayout(900, true, true);
    expect(narrow.aiOpen).toBe(false);

    // 拉宽窗口 → 响应式自动展开（用户没主动折叠过）。
    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.aiOpen).toBe(true);
  });

  it('AI 手动折叠后窗口变宽：保持折叠', () => {
    // prefersAi=false 是持久偏好 —— 拉宽窗口不会自动展开。
    const narrow = computeResponsiveLayout(900, false, true);
    expect(narrow.aiOpen).toBe(false);

    const wide = computeResponsiveLayout(1400, false, true);
    expect(wide.aiOpen).toBe(false);
  });

  it('任务列表同理：自动折叠 + 拉宽后自动恢复', () => {
    const narrow = computeResponsiveLayout(700, true, true);
    expect(narrow.listOpen).toBe(false);

    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.listOpen).toBe(true);
  });

  it('任务列表手动折叠后拉宽：保持折叠', () => {
    const narrow = computeResponsiveLayout(700, true, false);
    expect(narrow.listOpen).toBe(false);

    const wide = computeResponsiveLayout(1400, true, false);
    expect(wide.listOpen).toBe(false);
  });
});

describe('断点边界', () => {
  it('恰好等于 AI 断点时 AI 仍展开（边界归"宽"侧）', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI, true, true);
    expect(r.aiOpen).toBe(true);
  });

  it('恰好等于列表断点时任务列表仍展开', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST, true, true);
    expect(r.listOpen).toBe(true);
  });

  it('比列表断点小 1px 就折叠列表', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST - 1, true, true);
    expect(r.listOpen).toBe(false);
  });

  it('极小视口（320px）不会抛异常', () => {
    expect(() => computeResponsiveLayout(320, true, true)).not.toThrow();
    expect(computeResponsiveLayout(320, true, true).tier).toBe('single');
  });
});