// Sidebar — the leftmost navigation rail. VSCode-style ~48px-wide icon
// column with view-switcher items (今日 / 非今日 / 全部) at the top and the
// user-avatar chip pinned to the bottom. The avatar's popup menu (设置 /
// 关于 / 检查更新 / 退出) opens to the RIGHT of the rail so it can show full
// labels without being clipped by the column edge.
//
// Design intent:
//   - Icon-only items so the rail stays narrow; titles + aria-labels
//     handle accessibility (hover tooltip + screen-reader fallback).
//   - The avatar at the bottom is flex-pushed by .sidebar__spacer —
//     keeping it OUT of the icon-button rhythm (it has a different
//     visual weight, the gradient pill, and a popup menu) so the rail
//     reads as "icons + identity" rather than "all icons".
//   - onSelectFilter triggers App.tsx's listFilter state update + hash
//     sync (same path the Topbar filter buttons use).

import React from 'react';
import type { ListFilter } from '../router';
import { UserMenu } from '../components/UserMenu';

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

export const Sidebar: React.FC<{
  listFilter: ListFilter;
  onSelectFilter: (f: ListFilter) => void;
  onOpenSettings: () => void;
}> = ({ listFilter, onSelectFilter, onOpenSettings }) => (
  <nav className="sidebar" aria-label="侧边导航">
    {ITEMS.map((it) => {
      const active = listFilter.kind === it.kind;
      return (
        <button
          key={it.kind}
          type="button"
          className={`sidebar__item${active ? ' is-active' : ''}`}
          title={it.label}
          aria-label={it.label}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelectFilter({ kind: it.kind } as ListFilter)}
        >
          <Glyph name={it.icon} />
        </button>
      );
    })}
    <div className="sidebar__spacer" />
    <div className="sidebar__avatar-slot">
      <UserMenu onOpenSettings={onOpenSettings} />
    </div>
  </nav>
);

// SVG glyph collection — 24×24 viewBox, stroke width 1.8, heavier than the
// generic 16px icon-btn set so the rail's icons read at a glance
// (matching VSCode Activity Bar visual weight). Semantic shapes:
// today = large check (今日要做), non-today = horizontal bar / minus
// (今日不动 / 暂缓 — neutral, unlike × which implies "删除/错误"),
// all = three horizontal lines (complete list) — three shapes the eye
// can tell apart instantly without hover prompts.
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