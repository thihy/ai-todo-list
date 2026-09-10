// HistoryPopover — git-backed save history for the markdown editor body.
//
// Mounts as a popover anchored to the trigger button. Shows newest-first
// commits with timestamp + short SHA + commit message. Clicking a row shows
// a confirm prompt before restoring (overwriting the current body). When
// git isn't available (no `git` on PATH) the popover reports a one-line
// notice instead of an empty list.
//
// We deliberately don't try to show a diff inline — git diff against the
// file as it lives in the working tree would re-run against an editor that
// may be mid-edit. The user already has the History button next to Save;
// the affordance is "go back to an older revision", not "compare".

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGitHistory } from '../hooks/useTodoListApi';
import { IconHistory } from './icons';
import type { GitHistoryEntry } from '../../shared/todo-types';

export const HistoryPopover: React.FC<{
  todoId: string;
  /** Called after a successful restore so the editor can re-read its body
   *  and reset its `dirty` flag. */
  onRestored?: () => void;
}> = ({ todoId, onRestored }) => {
  const [open, setOpen] = useState(false);
  const { available, entries, refresh, restore } = useGitHistory(todoId);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-pull on open so a save that happened while the popover was closed
  // shows up without the user having to reload.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Outside-click closes the popover without restoring.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onRestore = useCallback(
    async (entry: GitHistoryEntry): Promise<void> => {
      if (!window.confirm(
        `恢复到 ${formatTime(entry.authorTs)} 的版本？\n当前未保存的内容将被覆盖。`,
      )) return;
      setBusy(entry.sha);
      const ok = await restore(entry.sha);
      setBusy(null);
      if (ok) {
        setOpen(false);
        onRestored?.();
      }
    },
    [restore, onRestored],
  );

  return (
    <div className="history-popover" ref={rootRef}>
      <button
        type="button"
        className={`history-popover__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="修改历史 (Git)"
        aria-label="修改历史"
        aria-expanded={open}
        // Hide the button entirely when git isn't on PATH — the user's
        // machine doesn't have git installed, the feature is unavailable.
        style={available ? undefined : { display: 'none' }}
      >
        <IconHistory size={14} />
      </button>
      {open && (
        <div className="history-popover__panel" role="dialog" aria-label="修改历史">
          <div className="history-popover__head">修改历史</div>
          {!available && (
            <div className="history-popover__empty">当前环境未安装 Git，无法记录历史。</div>
          )}
          {available && entries.length === 0 && (
            <div className="history-popover__empty">暂无历史。保存后会出现一条记录。</div>
          )}
          {available && entries.length > 0 && (
            <ol className="history-popover__list">
              {entries.map((e) => (
                <li key={e.sha} className="history-popover__item">
                  <div className="history-popover__row1">
                    <span className="history-popover__time">{formatTime(e.authorTs)}</span>
                    <span className="history-popover__sha">{e.sha.slice(0, 7)}</span>
                  </div>
                  <div className="history-popover__msg">{e.message}</div>
                  <button
                    type="button"
                    className="history-popover__restore"
                    onClick={() => void onRestore(e)}
                    disabled={busy !== null}
                  >
                    {busy === e.sha ? '恢复中…' : '恢复此版本'}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}