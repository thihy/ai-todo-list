// ProgressView — the task's progress surface in the detail body.
//
// Top row: a progress bar + percent + a "录入进展" toggle. The bar reads from
// the canonical `todo.progress` (refreshed via the app:data-changed broadcast
// after progress.log), so it stays honest even across AI/batch mutations.
//
// Toggle open: an entry form (range slider + number input synced, optional
// one-line note, Enter or 提交 to commit). Submit calls progress.log, which
// appends a progress_log row + bumps the todo's progress column.
//
// Collapsible timeline: every progress change (user-entered with a note, or
// AI/batch note-less) listed newest-first with time + percent + note.
//
// ProgressBar is exported so the summary header can render a compact
// at-a-glance bar without duplicating the styling.

import React, { useCallback, useEffect, useState } from 'react';
import { useProgress } from '../hooks/useThihyApi';

export const ProgressBar: React.FC<{
  value: number;
  className?: string;
  showLabel?: boolean;
}> = ({ value, className, showLabel }) => {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`progress-bar${className ? ' ' + className : ''}`}>
      <div className="progress-bar__track" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-bar__fill" style={{ width: `${v}%` }} />
      </div>
      {showLabel && <span className="progress-bar__label">{v}%</span>}
    </div>
  );
};

export const ProgressView: React.FC<{ todoId: string; progress: number }> = ({
  todoId,
  progress,
}) => {
  const { entries, log } = useProgress(todoId);
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(progress);
  const [note, setNote] = useState('');

  // Keep the slider in sync with the canonical progress when it changes
  // externally (e.g. another surface logged progress, or the todo reloaded).
  useEffect(() => {
    setPercent(progress);
  }, [progress]);

  const submit = useCallback(async () => {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    await log(p, note.trim() || undefined);
    setNote('');
    setOpen(false);
  }, [percent, note, log]);

  return (
    <section className="progress-view">
      <div className="progress-view__head">
        <ProgressBar value={progress} className="progress-view__bar" showLabel />
        <button
          type="button"
          className="progress-view__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '收起' : '录入进展'}
        </button>
      </div>

      {open && (
        <div className="progress-view__entry">
          <div className="progress-view__entry-row">
            <input
              type="range"
              min={0}
              max={100}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              aria-label="进度百分比"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="progress-view__percent"
              aria-label="进度数值"
            />
            <span className="progress-view__percent-sign">%</span>
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="一句话描述（可选）"
            className="progress-view__note"
            aria-label="进展描述"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="progress-view__entry-actions">
            <button type="button" className="progress-view__submit" onClick={() => void submit()}>
              提交
            </button>
            <button
              type="button"
              className="progress-view__cancel"
              onClick={() => {
                setOpen(false);
                setNote('');
                setPercent(progress);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <details className="progress-view__timeline" open>
          <summary className="progress-view__timeline-head">
            <span>进展历史</span>
            <span className="progress-view__timeline-count">{entries.length}</span>
          </summary>
          <ul className="progress-view__timeline-list">
            {entries.map((e) => (
              <li key={e.id} className="progress-view__timeline-item">
                <span className="progress-view__timeline-time">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="progress-view__timeline-percent">{e.percent}%</span>
                {e.note && <span className="progress-view__timeline-note">{e.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
};
