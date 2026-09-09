// PriorityPicker — a single "flag" button that opens a 4-item menu.
//
// Replaces the old always-visible row of four pill buttons (高/中/低/—)
// which was visually loud and demanded horizontal space proportional to the
// option count. The flag button shows the current priority's colour dot +
// label at a glance; clicking surfaces the four options in a popover.
//
// Semantic colouring: 高=danger / 中=warn / 低=info / 无=灰. The selected
// option renders solid; the others render outline so the current choice is
// instantly legible.

import React, { useEffect, useRef, useState } from 'react';
import type { Priority } from '../../shared/todo-types';

const OPTIONS: Array<{ value: Priority; label: string; color: string }> = [
  { value: 'high', label: '高', color: 'var(--accent-danger)' },
  { value: 'medium', label: '中', color: 'var(--accent-warn)' },
  { value: 'low', label: '低', color: 'var(--accent-info)' },
  { value: 'none', label: '无', color: 'var(--fg-muted)' },
];

function find(value: Priority): { value: Priority; label: string; color: string } {
  return OPTIONS.find((o) => o.value === value) ?? OPTIONS[3]!;
}

export const PriorityPicker: React.FC<{
  value: Priority;
  onChange: (v: Priority) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = find(value);

  // Close on outside click / Escape. The menu is small and unowned by a
  // dialog, so it must self-dismiss when focus leaves its subtree.
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
        className="priority-picker__flag"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`优先级：${current.label}，点击切换`}
        title={`优先级：${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
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
                  className={`priority-picker__option${selected ? ' is-selected' : ''}`}
                  style={{
                    color: selected ? '#fff' : o.color,
                    borderColor: o.color,
                    background: selected ? o.color : 'transparent',
                  }}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  <span className="priority-picker__dot" style={{ background: o.color }} />
                  {o.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
