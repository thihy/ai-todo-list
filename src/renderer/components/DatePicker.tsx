// DatePicker — read-first due-date affordance.
//
// Default: a read-mode chip showing relative + absolute + overdue phrasing
// ("明天 · 09-08", "已逾期 3 天", "无截止"). Clicking it does NOT swap the
// chip in place (that shifts the meta row's height); instead the edit
// controls surface as an absolute popover below the chip, so the row stays
// put. The popover holds a native date input + clear + quick chips.
//
// The old picker was an always-visible native `<input type="date">` — visually
// noisy and offered no sense of "when is this, relative to today". The read
// chip answers that at a glance; the edit popover is deliberately transient.

import React, { useEffect, useRef, useState } from 'react';
import { IconCalendar, IconClose } from './icons';
import { addDays, fromIsoDate, isOverdue, nextMonday, nextMonth, nextWeek, toIsoDate, formatDue } from '../utils/date';

export const DatePicker: React.FC<{
  value: number | null;
  onChange: (ms: number | null) => void;
}> = ({ value, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? toIsoDate(value) : '');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` written into a ref on every change so commit() (called
  // from onBlur) can read the *latest* value, not the stale closure value.
  // Without this, picking a date in the native picker would close our
  // popover (onBlur fires → setEditing(false)) but commit() would still see
  // the pre-pick draft because React batches the onChange setDraft before
  // the blur handler runs — so the picked date never made it to onChange.
  const draftRef = useRef(draft);

  // Reset the draft whenever the canonical value changes (e.g. external edit
  // or re-entry of the todo) so the popover opens with the current truth.
  useEffect(() => {
    setDraft(value != null ? toIsoDate(value) : '');
  }, [value]);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  // Auto-close the popover on outside click. Escape also cancels (restores
  // the canonical draft). The native date input doesn't fire blur reliably
  // when its picker popover is open, so we rely on a mousedown sentinel.
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

  // Read the live input value via the ref so we never commit a stale draft
  // (matters when blur fires immediately after change in the same tick).
  const commit = (): void => {
    setEditing(false);
    const live = inputRef.current?.value ?? draftRef.current;
    if (!live) {
      if (value != null) onChange(null);
      return;
    }
    const ms = fromIsoDate(live);
    if (ms !== value) onChange(ms);
  };

  const pick = (ms: number): void => {
    setDraft(toIsoDate(ms));
    draftRef.current = toIsoDate(ms);
    onChange(ms);
    setEditing(false);
  };

  const overdue = isOverdue(value);
  const label = formatDue(value);

  return (
    <div className="date-picker" ref={rootRef}>
      <button
        type="button"
        className={`date-picker__chip${overdue ? ' is-overdue' : ''}${value == null ? ' is-none' : ''}${editing ? ' is-active' : ''}`}
        aria-label={`截止日期：${label}，点击编辑`}
        title="点击编辑截止日期"
        aria-expanded={editing}
        onClick={() => setEditing((v) => !v)}
      >
        <IconCalendar size={14} className="date-picker__icon" />
        <span className="date-picker__label">{label}</span>
      </button>

      {editing && (
        <div className="date-picker__popover">
          <div className="date-picker__row">
            <input
              ref={inputRef}
              type="date"
              className="date-picker__input"
              aria-label="截止日期"
              value={draft}
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
                draftRef.current = e.target.value;
              }}
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
                <IconClose size={12} />
              </button>
            )}
          </div>
          <div className="date-picker__quick">
            <button type="button" onClick={() => pick(addDays(new Date(), 0).getTime())}>今天</button>
            <button type="button" onClick={() => pick(addDays(new Date(), 1).getTime())}>明天</button>
            <button type="button" onClick={() => pick(addDays(new Date(), 2).getTime())}>后天</button>
            <button type="button" onClick={() => pick(nextWeek(new Date()).getTime())}>下周</button>
            <button type="button" onClick={() => pick(nextMonday(new Date()).getTime())}>下周一</button>
            <button type="button" onClick={() => pick(nextMonth(new Date()).getTime())}>下月</button>
          </div>
        </div>
      )}
    </div>
  );
};
