// ProgressView — the task's progress surface, split into two pieces:
//
//   ProgressInline (基本信息):
//     [200px progress bar] [latest entry note] [v]
//     - Drag the bar to set progress; on release a note input pops up below
//       (auto-dismisses after 1 min idle or on outside-click; the progress is
//       already saved the moment the drag ends).
//     - Click the latest note to edit it in the same popover.
//     - The [v] toggles the full history timeline inline.
//
//   ProgressTimeline (动态 section, also reused inline by [v]):
//     Every progress change (user-entered with a note, or AI/batch note-less)
//     listed newest-first with time + percent + note.
//
// ProgressBar is exported so the summary header can render a compact
// at-a-glance bar without duplicating the styling.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProgress } from '../hooks/useThihyApi';
import { IconChevronDown } from './icons';

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

const IDLE_DISMISS_MS = 60_000;

/** Inline progress row for the 基本信息 section. See file header for the full
 *  interaction model (drag-to-set, note popover, click-to-edit, history v). */
export const ProgressInline: React.FC<{
  todoId: string;
  progress: number;
  onViewHistory?: () => void;
}> = ({ todoId, progress, onViewHistory }) => {
  const { entries, log, updateNote } = useProgress(todoId);
  const [percent, setPercent] = useState(progress);
  const [dragging, setDragging] = useState(false);
  // pendingEntryId = an entry just created by a drag, awaiting an optional note.
  // editingEntryId = an existing entry whose note the user clicked to edit.
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const idleTimer = useRef<number | null>(null);

  const latest = entries[0] ?? null;
  const latestNote = latest?.note?.trim() || '';
  const openEntryId = pendingEntryId ?? editingEntryId;
  const popoverOpen = openEntryId !== null;

  // Keep the local drag value honest with the canonical progress when not
  // actively dragging (e.g. another surface logged progress, or a reload).
  useEffect(() => {
    if (!dragging) setPercent(progress);
  }, [progress, dragging]);

  const pctFromX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return percent;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(rect.width, 1);
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }, [percent]);

  // Drag the bar to set progress. On release, if the value changed, commit it
  // (progress saved immediately) and open the note popover for that entry.
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(true);
    setPendingEntryId(null);
    setEditingEntryId(null);
    setNoteDraft('');
    const move = (ev: PointerEvent): void => setPercent(pctFromX(ev.clientX));
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      const finalP = pctFromX(ev.clientX);
      if (finalP !== progress) {
        void log(finalP).then((entry) => {
          if (entry) {
            setPendingEntryId(entry.id);
            setNoteDraft('');
          }
        });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    setPercent(pctFromX(e.clientX));
  };

  const closePopover = useCallback((): void => {
    setPendingEntryId(null);
    setEditingEntryId(null);
    setNoteDraft('');
  }, []);

  const commitNote = useCallback(async (): Promise<void> => {
    if (!openEntryId) return;
    const trimmed = noteDraft.trim();
    // Only write if there's something to say (empty = clear the note too, so
    // the user can blank a note they typed by mistake).
    await updateNote(openEntryId, trimmed || null);
    closePopover();
  }, [openEntryId, noteDraft, updateNote, closePopover]);

  // Focus + select the note input when the popover opens, and run the idle
  // auto-dismiss timer. The timer resets on each keystroke.
  useEffect(() => {
    if (!popoverOpen) {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      return;
    }
    noteInputRef.current?.focus();
    noteInputRef.current?.select();
    const arm = (): void => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(closePopover, IDLE_DISMISS_MS);
    };
    arm();
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, [popoverOpen, openEntryId, closePopover]);

  const resetIdle = useCallback((): void => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (popoverOpen) {
      idleTimer.current = window.setTimeout(closePopover, IDLE_DISMISS_MS);
    }
  }, [popoverOpen, closePopover]);

  // Outside-click closes the note popover (but not while dragging the bar).
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen, closePopover]);

  const onEditLatest = (): void => {
    if (!latest) return;
    setPendingEntryId(null);
    setEditingEntryId(latest.id);
    setNoteDraft(latest.note ?? '');
  };

  const shownPercent = dragging ? percent : progress;

  return (
    <div className="progress-inline">
      <div className="progress-inline__bar">
        {/* The bar is the drag affordance: pointer-down on the track scrubs
            the value; release commits it. The label reads the live value. */}
        <div
          className="progress-inline__bar-btn"
          role="slider"
          aria-label="任务进度（拖动调整）"
          aria-valuenow={Math.round(shownPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          title="拖动调整进度"
          onPointerDown={onTrackPointerDown}
        >
          <ProgressBar value={shownPercent} showLabel />
        </div>

        {/* Latest progress description — click to edit it. */}
        <span
          className={`progress-inline__note${latestNote ? ' is-editable' : ''}`}
          onClick={onEditLatest}
          title={latestNote ? '点击编辑描述' : undefined}
        >
          {latestNote || (latest ? '添加描述…' : '')}
        </span>

        {/* [v] expands the full history inline. */}
        <button
          type="button"
          className={`progress-inline__history-toggle${historyOpen ? ' is-open' : ''}`}
          aria-label={historyOpen ? '收起进度历史' : '展开进度历史'}
          aria-expanded={historyOpen}
          title="历史进度"
          onClick={(e) => {
            e.stopPropagation();
            if (!historyOpen && onViewHistory) onViewHistory();
            setHistoryOpen((v) => !v);
          }}
        >
          <IconChevronDown size={14} />
        </button>
      </div>

      {/* Note popover — for the pending (just-dragged) or editing (clicked)
          entry. Auto-dismisses after 1 min idle or on outside-click. */}
      {popoverOpen && (
        <div className="progress-inline__note-popover" ref={popoverRef}>
          <input
            ref={noteInputRef}
            type="text"
            className="progress-view__note"
            value={noteDraft}
            placeholder="一句话描述本次进展（可选）"
            aria-label="进展描述"
            onChange={(e) => { setNoteDraft(e.target.value); resetIdle(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitNote(); }
              else if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
            }}
            onBlur={() => { /* keep open on blur; idle/outside-click handles dismiss */ }}
          />
          <div className="progress-inline__note-hint">
            回车保存 · 空白处或 1 分钟后自动关闭
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="progress-inline__history">
          <ProgressTimeline todoId={todoId} />
        </div>
      )}
    </div>
  );
};

/** Full progress timeline for the 动态 section (and the inline [v] expand). */
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
