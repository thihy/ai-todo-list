// 响应式降级 —— 回归测试。
//
// 契约：窗口变窄时先收 AI 助手、再收任务列表；变宽时反向恢复。
// 顺序按"重要性递减"排：AI 是增强（没它任务照常用），任务列表是主从
// 布局的 master（主干的一部分），详情区永不自动收起。
//
// 另一个容易写错的点：响应式不能覆盖用户意图。用户手动关掉的 AI 面板，
// 不该因为窗口变宽就被自动打开。

import { describe, expect, it } from 'vitest';

import {
  BREAKPOINT_AI,
  BREAKPOINT_LIST,
  computeResponsiveLayout,
} from '../../src/renderer/hooks/useResponsiveLayout';

describe('computeResponsiveLayout — 降级顺序', () => {
  it('宽度充足：两栏都在', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI, true, true);
    expect(r).toEqual({ tier: 'full', aiVisible: true, listVisible: true });
  });

  it('低于 AI 断点：先只收 AI，任务列表保留', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI - 1, true, true);
    expect(r.aiVisible).toBe(false);
    expect(r.listVisible).toBe(true);
    expect(r.tier).toBe('list');
  });

  it('低于列表断点：AI 和任务列表都收，只剩详情', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST - 1, true, true);
    expect(r.aiVisible).toBe(false);
    expect(r.listVisible).toBe(false);
    expect(r.tier).toBe('single');
  });

  it('降级顺序确实是「先 AI 后列表」—— 中间那段宽度 AI 没了列表还在', () => {
    // 这条最容易在重构时被改成同时收，所以显式断言中间态。
    const mid = computeResponsiveLayout(BREAKPOINT_LIST + 1, true, true);
    expect(mid.aiVisible).toBe(false);
    expect(mid.listVisible).toBe(true);
  });
});

describe('computeResponsiveLayout — 恢复顺序（双向对称）', () => {
  it('从最窄逐级变宽：单栏 → 加任务列表 → 再加 AI', () => {
    const narrow = computeResponsiveLayout(700, true, true);
    expect(narrow.tier).toBe('single');

    const mid = computeResponsiveLayout(900, true, true);
    expect(mid.tier).toBe('list');
    expect(mid.listVisible).toBe(true);
    expect(mid.aiVisible).toBe(false);

    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.tier).toBe('full');
    expect(wide.listVisible).toBe(true);
    expect(wide.aiVisible).toBe(true);
  });

  it('逐级变窄是逐级收：先没 AI，再没列表', () => {
    const wide = computeResponsiveLayout(1400, true, true);
    expect(wide.aiVisible && wide.listVisible).toBe(true);

    const mid = computeResponsiveLayout(1000, true, true);
    expect(mid.aiVisible).toBe(false);
    expect(mid.listVisible).toBe(true);

    const narrow = computeResponsiveLayout(700, true, true);
    expect(narrow.aiVisible).toBe(false);
    expect(narrow.listVisible).toBe(false);
  });
});

describe('computeResponsiveLayout — 尊重用户意图', () => {
  it('用户手动关了 AI：窗口再宽也不自动打开', () => {
    const r = computeResponsiveLayout(1920, false, true);
    expect(r.aiVisible).toBe(false);
    expect(r.listVisible).toBe(true);
  });

  it('用户手动关了任务列表：窗口再宽也不自动打开', () => {
    const r = computeResponsiveLayout(1920, true, false);
    expect(r.aiVisible).toBe(true);
    expect(r.listVisible).toBe(false);
  });

  it('两个都手动关了：宽窗口下依然都不显示', () => {
    const r = computeResponsiveLayout(1920, false, false);
    expect(r.aiVisible).toBe(false);
    expect(r.listVisible).toBe(false);
  });

  it('用户意图为 false 时，窄屏降级结果不变（不越权干预）', () => {
    const r = computeResponsiveLayout(700, false, false);
    expect(r.aiVisible).toBe(false);
    expect(r.listVisible).toBe(false);
  });
});

describe('断点边界', () => {
  it('恰好等于 AI 断点时 AI 仍显示（边界归"宽"侧）', () => {
    const r = computeResponsiveLayout(BREAKPOINT_AI, true, true);
    expect(r.aiVisible).toBe(true);
  });

  it('恰好等于列表断点时任务列表仍显示', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST, true, true);
    expect(r.listVisible).toBe(true);
  });

  it('比列表断点小 1px 就收掉列表', () => {
    const r = computeResponsiveLayout(BREAKPOINT_LIST - 1, true, true);
    expect(r.listVisible).toBe(false);
  });

  it('极小视口（320px）不会抛异常', () => {
    expect(() => computeResponsiveLayout(320, true, true)).not.toThrow();
    expect(computeResponsiveLayout(320, true, true).tier).toBe('single');
  });
});
