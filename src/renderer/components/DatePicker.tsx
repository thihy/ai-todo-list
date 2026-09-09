// DatePicker — read-first due-date affordance.
//
// Default: a read-mode chip showing relative + absolute + overdue phrasing
// ("明天 · 09-08", "已逾期 3 天", "无截止"). Clicking it flips into edit mode
// with a native date input + clear button + quick "今天/明天/下周一" chips.
// Picking a date (or blurring) returns to read mode.
//
// The old picker was an always-visible native `<input type="date">` — visually
// noisy and offered no sense of "when is this, relative to today". The read
// chip answers that at a glance; the edit mode is deliberately transient.

import React, { useEffect, useRef, useState } from 'react';
import { addDays, fromIsoDate, isOverdue, nextMonday, toIsoDate, formatDue } from '../utils/date';

export const DatePicker: React.FC<{
  value: number | null;
  onChange: (ms: number | null) => void;
}> = ({ value, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? toIsoDate(value) : '');
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset the draft whenever the canonical value changes (e.g. external edit
  // or re-entry of the todo) so edit mode opens with the current truth.
  useEffect(() => {
    setDraft(value != null ? toIsoDate(value) : '');
  }, [value]);

  // Auto-close edit mode on outside click. Escape also cancels (restores the
  // canonical draft). The native date input doesn't fire blur reliably when
  // its picker popover is open, so we rely on a mousedown sentinel instead.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) commit();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setDraft(value != null ? toIsoDate(value) : ''); setEditing(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    if (!draft) {
      if (value != null) onChange(null);
      return;
    }
    const ms = fromIsoDate(draft);
    if (ms !== value) onChange(ms);
  };

  const pick = (ms: number): void => {
    setDraft(toIsoDate(ms));
    onChange(ms);
    setEditing(false);
  };

  const overdue = isOverdue(value);
  const label = formatDue(value);

  if (editing) {
    return (
      <div className="date-picker date-picker--edit" ref={rootRef}>
        <input
          type="date"
          className="date-picker__input"
          aria-label="截止日期"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
          }}
          onBlur={commit}
        />
        {value != null && (
          <button
            type="button"
            className="date-picker__clear"
            aria-label="清除截止日期"
            title="清除"
            onClick={() => { setDraft(''); onChange(null); setEditing(false); }}
          >
            ✕
          </button>
        )}
        <div className="date-picker__quick">
          <button type="button" onClick={() => pick(addDays(new Date(), 0).getTime())}>今天</button>
          <button type="button" onClick={() => pick(addDays(new Date(), 1).getTime())}>明天</button>
          <button type="button" onClick={() => pick(nextMonday().getTime())}>下周一</button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`date-picker date-picker--read${overdue ? ' is-overdue' : ''}${value == null ? ' is-none' : ''}`}
      aria-label={`截止日期：${label}，点击编辑`}
      title="点击编辑截止日期"
      onClick={() => setEditing(true)}
    >
      <svg className="date-picker__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="11" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1.5 5.5H12.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4 1V3.5M10 1V3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      <span className="date-picker__label">{label}</span>
    </button>
  );
};
