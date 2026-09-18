import React from 'react';

/** 今日 toggle 图标 — 12×12 圆形 + 时针。filled = 已加入今日。
 *  由 TaskRow（列表行尾）和 TodoEditorPane（详情标题栏）共用，
 *  所以挂在 components/ 而不是埋在某个 pane 内部。 */
const TodayGlyph: React.FC<{ planned?: boolean }> = ({ planned = false }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.5"
      fill={planned ? 'currentColor' : 'transparent'}
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M6 3.5V6L7.5 7.5" stroke={planned ? 'var(--bg-base)' : 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

export default TodayGlyph;
