// 响应式降级 —— 按视口宽度决定「三栏 / 两栏 / 单栏」。
//
// 问题：窗口变窄时，AI 面板（384px 基准）和任务列表（340px 基准）会把
// 中央详情区挤到不可用。原来只有 usePaneWidths 做**列宽缩放**，但缩放
// 到 MIN 之后就卡住了 —— 再窄下去三栏仍然并排，详情区被压到不可读。
//
// 策略：宽度不足时按"重要性递减"依次折叠次要面板为 rail。
//   AI 助手先折叠 —— 它是增强，不是主干；没有它所有任务功能照常可用。
//   任务列表后折叠 —— 它是主从布局的 master，主干的一部分。
//   详情区永不折叠 —— 它是当前正在工作的内容。
//
// AI 助手和任务列表本身都设计成"可折叠成 rail"的形态（手动折叠按钮
// 就是这个语义），所以"响应式自动折叠"等价于"响应式替用户按了一次折
// 叠按钮"：面板永远存在（不会消失），只是状态从展开变为折叠成 rail。
// 这比"窄窗口下整块面板消失"更连贯 —— 用户能看到折叠态的入口，
// 拉宽窗口就自然展开。
//
// 双向对称：窗口变宽时按相反顺序恢复（先恢复任务列表，再恢复 AI 助手）。
//
// 关键约束：响应式不能覆盖用户意图。用户手动关掉的 AI 面板（prefersAi
// = false），不该因为窗口变宽就被自动打开 —— 用户主动折叠是一个持久
// 偏好，与响应式临时建议无关。

import { useCallback, useEffect, useState } from 'react';

/** 收起 AI 助手的宽度阈值。低于它 → AI 自动折叠成 rail。 */
export const BREAKPOINT_AI = 1080;
/** 收起任务列表的宽度阈值。低于它 → 任务列表也折叠成 rail。 */
export const BREAKPOINT_LIST = 820;

/** 三种布局形态。数值越大，可用栏位越多。 */
export type ResponsiveTier = 'single' | 'list' | 'full';

export interface ResponsiveLayout {
  tier: ResponsiveTier;
  /** AI 面板是否处于**展开**态（占据 384px 内容）。false = 折叠成 rail。 */
  aiOpen: boolean;
  /** 任务列表是否处于**展开**态。false = 折叠成 rail。 */
  listOpen: boolean;
}

/**
 * 纯函数：给定视口宽度 + 用户的展开意图，算出 AI / 列表应该展开还是
 * 折叠成 rail。
 *
 * 语义：
 *   - prefersAi=true && 宽度够 → 展开
 *   - prefersAi=true && 宽度不够 → 折叠（响应式自动折叠 = rail）
 *   - prefersAi=false → 折叠（用户主动关了，不论窗口宽度）
 *
 * 抽成纯函数是为了能直接单测，不用起 DOM。
 */
export function computeResponsiveLayout(
  viewportW: number,
  prefersAi: boolean,
  prefersList: boolean,
): ResponsiveLayout {
  const widthFitsAi = viewportW >= BREAKPOINT_AI;
  const widthFitsList = viewportW >= BREAKPOINT_LIST;

  // "展开" = 用户希望展开 且 宽度足够。两个条件缺一就折叠成 rail。
  const aiOpen = prefersAi && widthFitsAi;
  const listOpen = prefersList && widthFitsList;

  const tier: ResponsiveTier = widthFitsAi ? 'full' : widthFitsList ? 'list' : 'single';

  return { tier, aiOpen, listOpen };
}

/** 跟踪视口宽度（rAF 合并高频 resize），配合上面的纯函数产出布局决策。 */
export function useResponsiveLayout(
  prefersAi: boolean,
  prefersList: boolean,
): ResponsiveLayout & { setViewportWidth: (w: number) => void } {
  const [viewportW, setViewportW] = useState<number>(() =>
    typeof window === 'undefined' ? BREAKPOINT_AI : window.innerWidth || BREAKPOINT_AI,
  );

  useEffect(() => {
    let frame = 0;
    const onResize = (): void => {
      if (frame) cancelAnimationFrame(frame);
      // rAF 合并：拖动窗口边缘时 resize 每秒能触发几十次，不合并会
      // 让整个布局跟着抖。
      frame = requestAnimationFrame(() => {
        frame = 0;
        setViewportW(window.innerWidth || BREAKPOINT_AI);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const setViewportWidth = useCallback((w: number) => setViewportW(w), []);
  return { ...computeResponsiveLayout(viewportW, prefersAi, prefersList), setViewportWidth };
}

/**
 * 把"用户手动切换"和"响应式自动折叠"合并成单一入口。
 *
 * 持久化的是 `prefers*`（用户意图）而不是 `aiOpen`（响应式结果）——
 * 否则窗口一窄就把 "AI 开着" 存成 false，下次在宽窗口启动时 AI
 * 莫名其妙是关的。
 *
 * toggleAi / toggleList 是更高层的"用户点了一下折叠/展开按钮"语义：
 * 切换的是 prefers*。AI 和列表行为对称。
 */
export function usePaneVisibility(initialAi: boolean, initialList: boolean) {
  const [prefersAi, setPrefersAi] = useState(initialAi);
  const [prefersList, setPrefersList] = useState(initialList);

  const layout = useResponsiveLayout(prefersAi, prefersList);

  const toggleAi = useCallback(() => {
    setPrefersAi((v) => !v);
  }, []);

  const toggleList = useCallback(() => {
    setPrefersList((v) => !v);
  }, []);

  // openAi / openList 用于"明确表达要开"的场景（如 'ai' route 跳转、
  // AI 新建任务后跳转的辅助展开）。即便窗口窄也强制设置偏好为开 —
  // 实际是否展开仍由 computeResponsiveLayout 结合宽度决定。
  const openAi = useCallback(() => {
    setPrefersAi(true);
  }, []);
  const openList = useCallback(() => {
    setPrefersList(true);
  }, []);

  return {
    ...layout,
    prefersAi,
    prefersList,
    // setPrefersAi / setPrefersList 保持原始 setState 语义（可直接吃
    // 布尔值）。toggleAi / toggleList 是更高层的"点了一下按钮"语义。
    setPrefersAi,
    setPrefersList,
    toggleAi,
    toggleList,
    openAi,
    openList,
  };
}