// ProgressView — the task's progress surface, split into two pieces:
//
//   ProgressInline (基本信息):
//     [drag-to-set progress bar | latest entry note]
//     The bar and the note each take half the row. Drag the bar to set
//     progress; on release a note input pops up below (auto-dismisses after
//     1 min idle or on outside-click; the progress is already saved the
//     moment the drag ends). Click the latest note to edit it in the same
//     popover.
//
//   ProgressTimeline (动态 section):
//     Every progress change (user-entered with a note, or AI/batch note-less)
//     listed newest-first with time + "进度 <prev>% → <curr>%" + note.
//
// ProgressBar is exported so the summary header can render a compact
// at-a-glance bar without duplicating the styling.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProgress } from '../hooks/useTodoListApi';

export const ProgressBar: React.FC<{
  value: number;
  className?: string;
  showLabel?: boolean;
  /** Render 20/40/60/80 tick marks on the track for at-a-glance landmarks. */
  showTicks?: boolean;
  /** Optional ref attached to the visual track element (not the wrapping
   *  .progress-bar). The drag handler reads from this so its
   *  getBoundingClientRect width equals the visible track width — which is
   *  what makes "鼠标在 100% 位置 = 进度条 100%" line up. */
  trackRef?: React.MutableRefObject<HTMLDivElement | null>;
}> = ({ value, className, showLabel, showTicks, trackRef }) => {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`progress-bar${className ? ' ' + className : ''}`}>
      <div
        ref={trackRef ?? undefined}
        className="progress-bar__track"
        role="progressbar"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-bar__fill" style={{ width: `${v}%` }} />
        {showTicks && [20, 40, 60, 80].map((p) => (
          <div
            key={p}
            className="progress-bar__tick"
            style={{ left: `${p}%` }}
            aria-hidden
          />
        ))}
      </div>
      {showLabel && <span className="progress-bar__label">{v}%</span>}
    </div>
  );
};

const IDLE_DISMISS_MS = 60_000;

/** Inline progress row for the 基本信息 section. See file header for the full
 *  interaction model (drag-to-set, click-to-edit note, post-drag note popover). */
export const ProgressInline: React.FC<{
  todoId: string;
  progress: number;
}> = ({ todoId, progress }) => {
  const { entries, log, updateNote } = useProgress(todoId);
  const [percent, setPercent] = useState(progress);
  const [dragging, setDragging] = useState(false);
  // pendingEntryId = an entry just created by a drag, awaiting an optional note.
  // editingEntryId = an existing entry whose note the user clicked to edit.
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

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
    const raw = Math.max(0, Math.min(100, ratio * 100));
    // Snap to a 5% grid so the user lands on round numbers when releasing
    // — matches the 20/40/60/80 tick marks visually.
    return Math.round(raw / 5) * 5;
  }, [percent]);

  // Drag the bar to set progress. On release, if the value changed, commit it
  // (progress saved immediately) and open the note popover for that entry.
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(true);
    setPendingEntryId(null);
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
    // Close BOTH modes: pending (just-logged via drag) and editing (clicked
    // an existing note). Without clearing editingEntryId, outside-click and
    // the 1-min idle timer only dismiss the post-drag variant — clicking an
    // existing note to edit it makes the popover sticky to outside clicks,
    // which reads as "I can't dismiss it". Both modes share the popover, so
    // both must be cleared to actually close it.
    setPendingEntryId(null);
    setEditingEntryId(null);
    setNoteDraft('');
  }, []);

  const commitNote = useCallback(async (): Promise<void> => {
    // Handle BOTH popover modes:
    //   - pending: just dragged the progress bar and got a fresh entry.
    //   - editing: clicked an existing note to edit it in place.
    // The previous version early-returned when pendingEntryId was null, so
    // editing-mode Enter silently did nothing — the popover stayed open and
    // outside-click only closed (not saved). User saw "I can't save my edit".
    const entryId = pendingEntryId ?? editingEntryId;
    if (!entryId) return;
    const trimmed = noteDraft.trim();
    // Only write if there's something to say (empty = clear the note too, so
    // the user can blank a note they typed by mistake).
    await updateNote(entryId, trimmed || null);
    closePopover();
  }, [pendingEntryId, editingEntryId, noteDraft, updateNote, closePopover]);

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
  }, [popoverOpen, pendingEntryId, closePopover]);

  const resetIdle = useCallback((): void => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (popoverOpen) {
      idleTimer.current = window.setTimeout(closePopover, IDLE_DISMISS_MS);
    }
  }, [popoverOpen, closePopover]);

  // Outside-click SAVES + closes (not just discards). If the user typed
  // something and clicked away, they almost certainly meant to keep the
  // change — discarding it is the surprising behavior, not saving it.
  // Escape still discards via the input's keydown handler.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        void commitNote();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen, commitNote]);

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
            the value; release commits it. The label reads the live value.
            trackRef is what pctFromX reads from — it MUST point at the same
            element that captures pointer events, otherwise getBoundingClientRect
            returns a stale rect (or null) and the drag silently no-ops. */}
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
          <ProgressBar value={shownPercent} showLabel showTicks trackRef={trackRef} />
        </div>

        {/* Latest progress description — click to edit it. Sits in the right
            half of the row (bar takes the left half; both share via the
            .progress-inline__bar flex parent). */}
        <span
          className={`progress-inline__note${latestNote ? ' is-editable' : ''}`}
          onClick={onEditLatest}
          title={latestNote ? '点击编辑描述' : undefined}
        >
          {latestNote || (latest ? '添加描述…' : '')}
        </span>
      </div>

      {/* Note popover — opens after a drag completes, for an optional note on
          the just-logged entry. Auto-dismisses after 1 min idle or on
          outside-click. */}
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
    </div>
  );
};

/** Full progress timeline for the 动态 section.
 *  Each entry reads as "进度 0% → 28%" so the audit story is one glance. The
 *  first entry (no prior) reads as "进度 0% → N%". */
export const ProgressTimeline: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { entries } = useProgress(todoId);
  if (entries.length === 0) {
    return <p className="progress-view__empty">暂无动态</p>;
  }
  // entries are newest-first; the "previous" value for entry[i] is entry[i+1].
  return (
    <ol className="progress-view__timeline-list">
      {entries.map((e, i) => {
        const prev = entries[i + 1];
        const fromPct = prev ? prev.percent : 0;
        const arrow =
          fromPct === e.percent
            ? `进度 ${e.percent}%（无变化）`
            : `进度 ${fromPct}% → ${e.percent}%`;
        const arrowClass =
          fromPct === e.percent
            ? 'progress-view__timeline-percent is-flat'
            : e.percent > fromPct
              ? 'progress-view__timeline-percent is-up'
              : 'progress-view__timeline-percent is-down';
        return (
          <li key={e.id} className="progress-view__timeline-item">
            <span className="progress-view__timeline-time">
              {new Date(e.createdAt).toLocaleString()}
            </span>
            <span className={arrowClass}>{arrow}</span>
            {e.note && <span className="progress-view__timeline-note">{e.note}</span>}
          </li>
        );
      })}
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
