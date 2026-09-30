// ActivityBar — VSCode 风格 Activity Bar。~48px 宽，只显示图标，点击切换
// 主视图（今日 / 非今日 / 全部）。当前选中用左侧高亮条 + accent 色标识。
//
// 设计意图：
//   - 不占文字标签的空间，让 TaskList 自身的 column 保持紧凑。
//   - 三个图标垂直排列，title / aria-label 给可访问性兜底（hover 提示文本）。
//   - 通过 selectFilter（App.tsx 提供）触发 listFilter state 更新 + hash 同步。

import React from 'react';
import type { ListFilter } from '../router';

type Item = {
  kind: ListFilter['kind'];
  label: string;
  icon: string;
};

const ITEMS: readonly Item[] = [
  { kind: 'today', label: '今日', icon: 'today' },
  { kind: 'non-today', label: '非今日', icon: 'non-today' },
  { kind: 'all', label: '全部', icon: 'list' },
] as const;

export const ActivityBar: React.FC<{
  listFilter: ListFilter;
  onSelectFilter: (f: ListFilter) => void;
}> = ({ listFilter, onSelectFilter }) => (
  <nav className="activity-bar" aria-label="视图切换">
    {ITEMS.map((it) => {
      const active = listFilter.kind === it.kind;
      return (
        <button
          key={it.kind}
          type="button"
          className={`activity-bar__item${active ? ' is-active' : ''}`}
          title={it.label}
          aria-label={it.label}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelectFilter({ kind: it.kind } as ListFilter)}
        >
          <Glyph name={it.icon} />
        </button>
      );
    })}
  </nav>
);

// SVG glyph 集合 —— 24×24 viewBox，笔画粗细 1.8，比通用 16px icon-btn
// 更厚重更易识别（VSCode Activity Bar 图标的视觉重量）。
// 语义化设计：today = 大对勾（今日要做），non-today = 粗横线 / 减号
// （今日不动 / 暂缓 —— 中性不冲突，不像 X 容易让人联想到"删除/错误"），
// all = 三条横线（完整清单）—— 一眼就能区分，不必 hover 提示。
const ICONS: Record<string, string> = {
  list: 'M5 6.5H19 M5 12H19 M5 17.5H15',
  today: 'M5 12.5L10 17.5L19 7.5',
  'non-today': 'M7 12H17',
};

const Glyph: React.FC<{ name: string }> = ({ name }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d={ICONS[name] ?? ''}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);