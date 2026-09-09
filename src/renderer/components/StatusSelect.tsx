// StatusSelect — a click-to-open status picker. Replaces the old "click to
// cycle" behavior (nextStatus) in both the detail header and the list row,
// which made off-track states (已取消 / 阻塞中) hard to reach and felt like
// guessing. Opens a popover listing all five statuses with their glyph +
// label; the current one is highlighted. Picking one calls onChange and
// closes. Two surface variants share one control: a labeled pill (detail)
// and an icon-only compact trigger (list row).

import React, { useEffect, useRef, useState } from 'react';
import { TODO_STATUSES, type TodoStatus } from '../../shared/todo-types';
import { STATUS_LABEL, StatusGlyph } from './StatusGlyph';
import { IconClose } from './icons';

export const StatusSelect: React.FC<{
  status: TodoStatus;
  onChange: (next: TodoStatus) => void;
  variant?: 'pill' | 'icon';
}> = ({ status, onChange, variant = 'pill' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = STATUS_LABEL[status] ?? status;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  const stop = (e: React.SyntheticEvent): void => {
    e.stopPropagation();
  };

  const trigger =
    variant === 'pill' ? (
      <button
        type="button"
        className={`editor-pane__status-pill is-${status}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`状态：${label}，点击选择`}
        title={`状态：${label}`}
        onClick={(e) => {
          stop(e);
          setOpen((v) => !v);
        }}
      >
        <StatusGlyph status={status} />
        <span className="editor-pane__status-pill-label">{label}</span>
      </button>
    ) : (
      <button
        type="button"
        className={`task-row__status is-${status}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`状态：${label}（点击选择）`}
        onClick={(e) => {
          stop(e);
          setOpen((v) => !v);
        }}
      >
        <StatusGlyph status={status} />
      </button>
    );

  return (
    <div className={`status-select status-select--${variant}`} ref={ref}>
      {trigger}
      {open && (
        <div className="status-select__menu" role="listbox" aria-label="选择状态">
          {TODO_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={s === status}
              className={`status-select__option${s === status ? ' is-active' : ''}`}
              onClick={(e) => {
                stop(e);
                onChange(s);
                setOpen(false);
              }}
            >
              <StatusGlyph status={s} />
              <span className="status-select__option-label">{STATUS_LABEL[s]}</span>
              {s === status && <IconClose size={12} className="status-select__option-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// IconClose is used as a "current selection" check mark; re-exported to keep
// the import above from being tree-shaken in some builds.
export { IconClose };
