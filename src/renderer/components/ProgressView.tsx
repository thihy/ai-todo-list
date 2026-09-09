// ProgressView — the task's progress surface, split into two pieces that
// live in different detail sub-sections:
//
//   ProgressInline (基本信息):
//     [progress bar] [latest entry note] [录入进度]
//     The bar shows the canonical `todo.progress` (refreshed via the
//     app:data-changed broadcast after progress.log). Clicking the bar opens
//     the history timeline (scrolls to / expands the 动态 section). The
//     录入进度 button toggles an inline entry form (range + number + note).
//     The latest entry's note is shown next to the bar by default.
//
//   ProgressTimeline (动态):
//     Every progress change (user-entered with a note, or AI/batch note-less)
//     listed newest-first with time + percent + note.
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

/** Inline progress row for the 基本信息 section:
 *   ============---- 30%  <latest description>
 *   The bar itself is the affordance — click it to open an inline panel with
 *   the entry form (录入新进度) and a "view history ↓" link that jumps to the
 *   动态 section. There is no separate button; the bar does double duty. */
export const ProgressInline: React.FC<{
  todoId: string;
  progress: number;
  onViewHistory?: () => void;
}> = ({ todoId, progress, onViewHistory }) => {
  const { entries, log } = useProgress(todoId);
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(progress);
  const [note, setNote] = useState('');

  const latest = entries[0];
  const latestNote = latest?.note?.trim() || '';

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
    <div className="progress-inline">
      <div className="progress-inline__bar">
        <button
          type="button"
          className="progress-inline__bar-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title="点击录入进度 / 查看历史"
        >
          <ProgressBar value={progress} showLabel />
        </button>
        {latestNote && <span className="progress-inline__note">{latestNote}</span>}
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
            {onViewHistory && (
              <button
                type="button"
                className="progress-inline__history-link"
                onClick={onViewHistory}
              >
                查看历史 ↓
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** Full progress timeline for the 动态 section. */
export const ProgressTimeline: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { entries } = useProgress(todoId);
  if (entries.length === 0) {
    return <p className="progress-view__empty">暂无动态</p>;
  }
  return (
    <ol className="progress-view__timeline-list">
      {entries.map((e) => (
        <li key={e.id} className="progress-view__timeline-item">
          <span className="progress-view__timeline-time">
            {new Date(e.createdAt).toLocaleString()}
          </span>
          <span className="progress-view__timeline-percent">{e.percent}%</span>
          {e.note && <span className="progress-view__timeline-note">{e.note}</span>}
        </li>
      ))}
    </ol>
  );
};

/** @deprecated retained for backward-compat; prefer ProgressInline + ProgressTimeline. */
export const ProgressView: React.FC<{ todoId: string; progress: number }> = ({
  todoId,
  progress,
}) => (
  <section className="progress-view">
    <ProgressInline todoId={todoId} progress={progress} />
    <ProgressTimeline todoId={todoId} />
  </section>
);
