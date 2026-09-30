// 响应式降级 —— 按视口宽度决定「三栏 / 两栏 / 单栏」。
//
// 问题：窗口变窄时，AI 面板（384px 基准）和任务列表（340px 基准）会把
// 中央详情区挤到不可用。原来只有 usePaneWidths 做**列宽缩放**，但缩放
// 到 MIN 之后就卡住了 —— 再窄下去三栏仍然并排，详情区被压到不可读。
//
// 策略：宽度不足时按"重要性递减"依次收起次要面板。
//   AI 助手先收 —— 它是增强，不是主干；没有它所有任务功能照常可用。
//   任务列表后收 —— 它是主从布局的 master，主干的一部分。
//   详情区永不自动收起 —— 它是当前正在工作的内容。
//
// 双向对称：窗口变宽时按相反顺序恢复（先恢复任务列表，再恢复 AI 助手）。
// 顺序反过来是有讲究的：先让用户找回 master，再把 AI 加回来，这样每一
// 步恢复的都是"我刚才在做的事"。
//
// 关键约束：这是**自动**降级，不是覆盖用户意图。用户手动关掉的 AI 面板
// 在窗口变宽时不应该被自动打开 —— 所以用 `prefersAi` / `prefersList`
// 记录"用户希望它开着"，响应式只在这个前提为真时才允许展开。这样两种
// 情况都能正确处理：
//   - 用户没动过面板（prefers = true）→ 完全交给响应式决定。
//   - 用户手动关了（prefers = false）→ 响应式不碰它。

import { useCallback, useEffect, useRef, useState } from 'react';

/** 收起 AI 助手的宽度阈值。低于它 → AI 先折叠。 */
export const BREAKPOINT_AI = 1080;
/** 收起任务列表的宽度阈值。低于它 → 任务列表也折叠。 */
export const BREAKPOINT_LIST = 820;

/** 三种布局形态。数值越大，可用栏位越多。 */
export type ResponsiveTier = 'single' | 'list' | 'full';

export interface ResponsiveLayout {
  tier: ResponsiveTier;
  /** 最终是否渲染 AI 面板（响应式与用户意图的交集）。 */
  aiVisible: boolean;
  /** 最终是否渲染任务列表。 */
  listVisible: boolean;
}

/**
 * 纯函数：给定视口宽度 + 用户的展开意图，算出该显示哪些面板。
 * 抽成纯函数是为了能直接单测，不用起 DOM。
 *
 * @param viewportW 视口宽度（px）
 * @param prefersAi 用户是否希望 AI 助手展开（手动关过则为 false）
 * @param prefersList 用户是否希望任务列表展开
 */
export function computeResponsiveLayout(
  viewportW: number,
  prefersAi: boolean,
  prefersList: boolean,
): ResponsiveLayout {
  // 宽度够 → 两边都尊重用户意图。
  if (viewportW >= BREAKPOINT_AI) {
    return { tier: 'full', aiVisible: prefersAi, listVisible: prefersList };
  }
  // 中等宽度：AI 让位，任务列表保留。
  if (viewportW >= BREAKPOINT_LIST) {
    return { tier: 'list', aiVisible: false, listVisible: prefersList };
  }
  // 很窄：只剩详情区。任务列表同样尊重用户意图 —— 用户主动关过就别
  // 替他打开。
  return { tier: 'single', aiVisible: false, listVisible: false };
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
 * 为什么需要它：App 里 aiOpen / listOpen 同时被两种东西驱动 —— 用户点
 * 顶栏/面板的按钮（手动），以及响应式（自动）。如果直接各自 setState，
 * 会出现"响应式刚把 AI 收起来，用户手动开一下，宽度没变，下个 resize
 * 又收起"的抖动。这里保证：手动切换只改 `prefers*`，可见性始终由
 * computeResponsiveLayout 推导。
 */
export function usePaneVisibility(initialAi: boolean, initialList: boolean) {
  const [prefersAi, setPrefersAi] = useState(initialAi);
  const [prefersList, setPrefersList] = useState(initialList);
  // 记录"上一次自动折叠"的用户意图，窗口变宽时用它恢复。
  const aiBeforeCollapse = useRef<boolean | null>(null);
  const listBeforeCollapse = useRef<boolean | null>(null);

  const layout = useResponsiveLayout(prefersAi, prefersList);

  // 响应式自动收起的面板，记录它"折叠前"用户的意图。
  useEffect(() => {
    if (layout.aiVisible) {
      aiBeforeCollapse.current = null;
    } else if (aiBeforeCollapse.current === null) {
      aiBeforeCollapse.current = prefersAi;
    }
  }, [layout.aiVisible, prefersAi]);

  useEffect(() => {
    if (layout.listVisible) {
      listBeforeCollapse.current = null;
    } else if (listBeforeCollapse.current === null) {
      listBeforeCollapse.current = prefersList;
    }
  }, [layout.listVisible, prefersList]);

  // 手动点开一个正被自动折叠的面板时，把它从"自动"转为"用户要开"，
  // 这样后续 resize 不会立刻又把它收掉。
  const openAi = useCallback(() => {
    aiBeforeCollapse.current = null;
    setPrefersAi(true);
  }, []);

  const toggleAi = useCallback(() => {
    setPrefersAi((v) => {
      // 手动点开一个正被自动折叠的面板时，把它从"自动"转为"用户要开"，
      // 这样后续 resize 不会立刻又把它收掉。
      if (!v && aiBeforeCollapse.current) aiBeforeCollapse.current = null;
      return !v;
    });
  }, []);

  const toggleList = useCallback(() => {
    setPrefersList((v) => {
      if (!v && listBeforeCollapse.current) listBeforeCollapse.current = null;
      return !v;
    });
  }, []);

  return {
    ...layout,
    prefersAi,
    prefersList,
    // 面板是被响应式收掉的（而非用户手动关的）。UI 用它决定是渲染
    // 展开把手还是彻底不渲染。
    aiAutoCollapsed: !layout.aiVisible && prefersAi,
    listAutoCollapsed: !layout.listVisible && prefersList,
    // setPrefersAi 保持原始 setState 语义（可直接吃布尔值），额外给一个
    // openAi 处理"从自动折叠中转成用户意图"的语义。两者都稳定引用，可安全
    // 放进 useEffect 依赖。
    setPrefersAi,
    setPrefersList,
    openAi,
    toggleAi,
    toggleList,
  };
}
