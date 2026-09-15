// PriorityPicker — a compact pill trigger that opens a 5-item popover.
//
// Mirrors StatusSelect's menu aesthetic so the detail meta row reads as one
// family: neutral menu rows where colour is carried by a small dot only
// (the previous version bordered every option in its own colour, which read
// as a noisy rainbow). The selected option gets a check mark, not a fill.
//
// Semantic colouring: 极高/高=danger / 中=warn / 低=info / 极低=muted.

import React, { useEffect, useRef, useState } from 'react';
import { IconCheck, IconFlag } from './icons';
import type { Priority } from '../../shared/todo-types';

interface Option {
  value: Priority;
  label: string;
  color: string;
}

// 5 档优先级（从高到低排列 —— 视觉上"重要"的选项靠前，方便快速定位）。
// 极高和高共用同一 danger 色 —— 它们之间靠 emoji / 文字区分，不靠颜色；
// 这样最危险的色（红）不会被稀释，又能保留 5 档区分。
const OPTIONS: Option[] = [
  { value: 'very-high', label: '极高', color: '#991B1B' },
  { value: 'high',      label: '高',   color: 'var(--accent-danger)' },
  { value: 'medium',    label: '中',   color: 'var(--accent-warn)' },
  { value: 'low',       label: '低',   color: 'var(--accent-info)' },
  { value: 'very-low',  label: '极低', color: 'var(--fg-muted)' },
];

function find(value: Priority): Option {
  return OPTIONS.find((o) => o.value === value) ?? OPTIONS[4]!;
}

export const PriorityPicker: React.FC<{
  value: Priority;
  onChange: (v: Priority) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = find(value);

  // Close on outside click / Escape — the menu is unowned by a dialog, so it
  // must self-dismiss when focus leaves its subtree.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="priority-picker" ref={rootRef}>
      <button
        type="button"
        className="priority-picker__pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`优先级：${current.label}，点击切换`}
        title={`优先级：${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconFlag size={14} className="priority-picker__flag-icon" />
        <span className="priority-picker__dot" style={{ background: current.color }} />
        <span className="priority-picker__label">{current.label}</span>
      </button>

      {open && (
        <ul className="priority-picker__menu" role="listbox" aria-label="优先级">
          {OPTIONS.map((o) => {
            const selected = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`priority-picker__option${selected ? ' is-active' : ''}`}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  <span className="priority-picker__dot" style={{ background: o.color }} />
                  <span className="priority-picker__option-label">{o.label}</span>
                  {selected && <IconCheck size={14} className="priority-picker__option-check" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
