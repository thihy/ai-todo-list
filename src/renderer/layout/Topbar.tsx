// Topbar — the frameless title bar. Holds:
//   1. Brand (logo + product name + project switcher chevron) on the left.
//   2. Filter / sort / search controls (in-panel actions live in the task list,
//      the topbar keeps the menu + a compact Cmd-K search).
//   3. Flat menu-category buttons (文件 / 编辑 / 视图 / 窗口 / 帮助) that pop
//      their native submenu via window.todoList.app.popupMenuCategory.
//   4. Drag spacer + native caption buttons (env titlebar-area).
//
// Visually the topbar shares its background with the sidebar underneath
// (both bg-surface) and drops the bottom border, so the two read as one
// continuous chrome band. The brand mark / project switcher lives here,
// NOT in the sidebar header — the sidebar only hosts list-scoped actions
// (notification / search / collapse) plus the user avatar at its footer.

import React from 'react';
import { FilterButton } from '../components/FilterPopover';
import { SortButton } from '../components/SortPopover';
import type { ListFilter, SortKey } from '../router';

const MENU_CATEGORIES = ['文件', '编辑', '视图', '窗口', '帮助'] as const;

export const Topbar: React.FC<{
  onOpenPalette: () => void;
  listFilter: ListFilter;
  onSelectFilter: (f: ListFilter) => void;
  listSort: SortKey;
  onSelectSort: (s: SortKey) => void;
}> = ({ onOpenPalette, listFilter, onSelectFilter, listSort, onSelectSort }) => {
  return (
    <header className="topbar">
      {/* Brand badge — purely visual. We don't ship project switching in
         this build (single-tenant app), so the chevron + button affordance
         were misleading dead UI. Just renders the logo + product name;
         the whole topbar remains draggable via -webkit-app-region on the
         header itself. */}
      <div className="topbar__brand">
        <Logo />
        <span className="topbar__name">AI 待办</span>
      </div>

      <div className="topbar__tools">
        <FilterButton filter={listFilter} onSelect={onSelectFilter} />
        <SortButton sort={listSort} onSelect={onSelectSort} />
        <button
          type="button"
          className="icon-btn topbar__tool"
          aria-label="搜索"
          title="搜索（Ctrl K）"
          onClick={onOpenPalette}
        >
          <SearchIcon />
        </button>
      </div>

      <div className="topbar__menu" role="menubar" aria-label="应用菜单">
        {MENU_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className="topbar__menu-item"
            role="menuitem"
            onClick={() => void window.todoList.app.popupMenuCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="topbar__spacer" />
    </header>
  );
};

const Logo: React.FC = () => (
  <svg className="topbar__logo" width="22" height="22" viewBox="0 0 256 256" aria-hidden="true">
    <defs>
      <linearGradient id="tl-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#34D399" />
        <stop offset="1" stopColor="#047857" />
      </linearGradient>
    </defs>
    <rect x="12" y="12" width="232" height="232" rx="56" fill="url(#tl-g)" />
    <g stroke="#fff" strokeWidth="12" strokeLinecap="round">
      <line x1="98" y1="96" x2="184" y2="96" />
      <line x1="98" y1="128" x2="184" y2="128" />
      <line x1="98" y1="160" x2="156" y2="160" />
    </g>
    <g fill="#fff">
      <circle cx="78" cy="96" r="9" />
      <circle cx="78" cy="128" r="9" />
      <circle cx="78" cy="160" r="9" />
    </g>
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10.5 10.5L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);