// Sort popover — title-bar 排序 button, sits right next to the 过滤 button.
// Switches the task-list sort key. Like the filter button it's deep-linkable:
// selecting an item updates App listSort state and the #/list/<path>?sort=<key>
// hash so the chosen order persists across reloads and links.
//
// Sort keys:
//   alpha   字母顺序 (default) — A→Z, Chinese-aware localeCompare with numeric ordering
//   created 创建日期           — newest first
//   due     截止日期           — soonest first, no-due last
//   priority 优先级           — high → medium → low → none
//
// The comparator itself lives in TodoListPane (it owns the tree), so this
// popover is purely a picker over SORT_KEYS.

import React, { useEffect, useRef, useState } from 'react';
import type { SortKey } from '../router';
import { SORT_KEYS } from '../router';

export const SORT_LABEL: Record<SortKey, string> = {
  alpha: '字母顺序',
  created: '创建日期',
  due: '截止日期',
  priority: '优先级',
};

export const SortButton: React.FC<{
  sort: SortKey;
  onSelect: (s: SortKey) => void;
}> = ({ sort, onSelect }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="filter-button" ref={ref}>
      <button
        type="button"
        className={`icon-btn topbar__tool${open ? ' is-open' : ''}`}
        aria-label="排序"
        aria-expanded={open}
        aria-haspopup="menu"
        title={`排序（当前：${SORT_LABEL[sort]}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <SortIcon />
      </button>
      {open && (
        <div className="filter-popover" role="menu" aria-label="排序方式">
          <div className="filter-popover__section">
            <div className="filter-popover__title">排序方式</div>
            {SORT_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={sort === k}
                className={`filter-popover__item${sort === k ? ' is-active' : ''}`}
                onClick={() => {
                  onSelect(k);
                  setOpen(false);
                }}
              >
                {SORT_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const SortIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {/* ascending bars + a chevron pointing up-to-down to convey "ordered" */}
    <path d="M5 2.5v8M5 10.5L3 8M5 10.5L7 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 5h4M9 8h4M9 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
