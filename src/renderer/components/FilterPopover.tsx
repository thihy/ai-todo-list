// Filter popover — title-bar 过滤 button. Switches the task-list filter
// (view / priority). Lives in the top bar; selecting an item updates
// App listFilter state and the #/list/<path> hash so it's deep-linkable.

import React, { useEffect, useRef, useState } from 'react';
import type { ListFilter } from '../router';

export const FilterButton: React.FC<{
  filter: ListFilter;
  onSelect: (f: ListFilter) => void;
}> = ({ filter, onSelect }) => {
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
        aria-label="过滤"
        aria-expanded={open}
        aria-haspopup="menu"
        title="过滤任务"
        onClick={() => setOpen((v) => !v)}
      >
        <FilterIcon />
      </button>
      {open && (
        <div className="filter-popover" role="menu" aria-label="过滤条件">
          <FilterSection title="视图">
            <FilterItem active={filter.kind === 'all'} label="全部" onClick={() => choose({ kind: 'all' })} />
            {/* 今天 / 未来 7 天 的"按截止日期"视图被新的"今日待办 / 其他任务"
                双区视图替代（见 TodoListPane 上半区）。按状态过滤保留下来，
                因为它语义独立（"未完成" = status=next，不依赖日期）。 */}
            <FilterItem active={filter.kind === 'status' && filter.status === 'next'} label="未完成" onClick={() => choose({ kind: 'status', status: 'next' })} />
            <FilterItem active={filter.kind === 'archived'} label="归档" onClick={() => choose({ kind: 'archived' })} />
            <FilterItem active={filter.kind === 'deleted'} label="已删除" onClick={() => choose({ kind: 'deleted' })} />
          </FilterSection>
          <FilterSection title="优先级">
            {(['very-high', 'high', 'medium', 'low', 'very-low'] as const).map((p) => (
              <FilterItem
                key={p}
                active={filter.kind === 'priority' && filter.priority === p}
                label={PRIO_LABEL[p]}
                onClick={() => choose({ kind: 'priority', priority: p })}
              />
            ))}
          </FilterSection>
        </div>
      )}
    </div>
  );

  function choose(f: ListFilter): void {
    onSelect(f);
    setOpen(false);
  }
};

const PRIO_LABEL: Record<string, string> = { 'very-high': '极高', high: '高', medium: '中', low: '低', 'very-low': '极低' };

const FilterSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="filter-popover__section">
    <div className="filter-popover__title">{title}</div>
    {children}
  </div>
);

const FilterItem: React.FC<{ active: boolean; label: string; onClick: () => void }> = ({ active, label, onClick }) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={active}
    className={`filter-popover__item${active ? ' is-active' : ''}`}
    onClick={onClick}
  >
    {label}
  </button>
);

const FilterIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 4H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M4 8H12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M6.5 12H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
