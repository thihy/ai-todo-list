// 每日计划引导 modal — 启动时若今天还没有任何 plannedFor，弹全屏让用户从
// 候选列表中挑选任务加入今日（默认勾前 5 个）。用户也可「跳过」或「改天再提醒」
// （24h 内不再弹）。
//
// 设计要点：
// - 全屏 role=dialog aria-modal=true，仿 SettingsModal 的样式锚点。
// - 候选列表排序：高优先级 > 截止日期最近 > 字母顺序。title 截断到 64 字符
//   避免候选列表一行过长。
// - ESC / backdrop click 都关闭（等同「跳过」语义 —— 关闭后写 lastPlanGuideDate）。
// - 「改天再提醒」把 snoozePlanGuideUntil = now + 24h，关闭 modal 并导航到主页。
// - 「确认」逐个 update 任务 plannedFor = todayStart，最后写 lastPlanGuideDate。
//
// 这条 modal 同时被两处触发：
//   1. App.tsx 启动 effect：lastPlanGuideDate !== today || snoozePlanGuideUntil
//      未过期 + 今天没有 plannedFor → 自动打开。
//   2. main 进程的通知点击：发 app:plan-guide 事件，App.tsx 监听并同样打开。

import React, { useEffect, useMemo, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { useDimTitleBar } from '../hooks/useDimTitleBar';

const PRIORITY_WEIGHT: Record<NonNullable<Todo['priority']>, number> = {
  'very-high': 5,
  high: 4,
  medium: 3,
  low: 2,
  'very-low': 1,
};
const PRIORITY_LABEL: Record<NonNullable<Todo['priority']>, string> = {
  'very-high': '极高',
  high: '高',
  medium: '中',
  low: '低',
  'very-low': '极低',
};

const CANDIDATE_LIMIT = 12;
const DEFAULT_SELECTED = 5;

function sortCandidates(todos: Todo[]): Todo[] {
  // 高优先级 → 截止日期最近（无 due 推到队尾）→ 字母顺序。
  // 注意是候选排序，不影响 TodoListPane 既有 sortKey。
  return todos.slice().sort((a, b) => {
    const pw = PRIORITY_WEIGHT[b.priority ?? 'very-low'] - PRIORITY_WEIGHT[a.priority ?? 'very-low'];
    if (pw !== 0) return pw;
    if (a.dueAt == null && b.dueAt == null) {
      return (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN', { sensitivity: 'base' });
    }
    if (a.dueAt == null) return 1;
    if (b.dueAt == null) return -1;
    return a.dueAt - b.dueAt;
  });
}

function todayKey(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDue(dueAt: number | null): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export const PlanGuideModal: React.FC<{
  open: boolean;
  /** All active (non-archived, non-deleted) todos. The modal filters & sorts
   *  to its own candidate slice. */
  candidates: Todo[];
  /** Today's local date 'YYYY-MM-DD'. The modal writes this verbatim to
   *  plannedFor so the upper-section equality check matches. */
  todayKey: string;
  /** Called when the user confirms a non-empty selection. The caller is
   *  responsible for writing the plannedFor updates AND lastPlanGuideDate. */
  onConfirm: (ids: string[]) => Promise<void>;
  /** Called when the user clicks 「跳过」 / closes the dialog. The caller
   *  writes lastPlanGuideDate so we don't re-prompt the same day. */
  onSkip: () => Promise<void>;
  /** Called when the user clicks 「改天再提醒」. The caller writes
   *  snoozePlanGuideUntil = now + 24h. */
  onSnooze: () => Promise<void>;
}> = ({ open, candidates, todayKey: today, onConfirm, onSkip, onSnooze }) => {
  // Dim the frameless titleBarOverlay while this modal is up — see
  // useDimTitleBar for the IPC rationale.
  useDimTitleBar(open);
  const sorted = useMemo(() => sortCandidates(candidates).slice(0, CANDIDATE_LIMIT), [candidates]);
  // Default selection: top DEFAULT_SELECTED checked. Pre-seed once on mount;
  // user edits take over. The dependency on `sorted.length` re-seeds when the
  // candidate set changes (e.g. AI created a new task while modal was open).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sorted.slice(0, DEFAULT_SELECTED).map((t) => t.id)));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(sorted.slice(0, DEFAULT_SELECTED).map((t) => t.id)));
    setBusy(false);
  }, [open, sorted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void doSkip();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // doSkip captures busy/onSkip; only attach while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doConfirm = async (): Promise<void> => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      await onConfirm(Array.from(selected));
    } finally {
      setBusy(false);
    }
  };

  const doSkip = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onSkip();
    } finally {
      setBusy(false);
    }
  };

  const doSnooze = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onSnooze();
    } finally {
      setBusy(false);
    }
  };

  const noCandidates = sorted.length === 0;
  const noActivePlannedToday = candidates.every((t) => t.plannedFor !== today);

  return (
    <div className="settings-modal plan-guide-modal" role="dialog" aria-modal="true" aria-label="今日待办">
      <div className="settings-modal__backdrop" onClick={doSkip} />
      <div className="settings-modal__dialog plan-guide-modal__dialog">
        <header className="settings-modal__header">
          <h2 className="settings-modal__title">今天安排些什么？</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={busy}
            onClick={doSkip}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4L12 12 M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="plan-guide-modal__body">
          {!noActivePlannedToday && candidates.some((t) => t.plannedFor === today) && (
            <div className="plan-guide-modal__hint">
              今天已有任务在「今日待办」。下面列出还没安排的候选，可以再追加。
            </div>
          )}
          {noCandidates && (
            <div className="plan-guide-modal__empty">
              <div className="plan-guide-modal__empty-title">暂无未完成的任务</div>
              <div className="plan-guide-modal__empty-hint">
                先新建一些任务，明天启动时会再次询问安排。
              </div>
            </div>
          )}
          {!noCandidates && (
            <ul className="plan-guide-modal__list">
              {sorted.map((t) => {
                const checked = selected.has(t.id);
                return (
                  <li key={t.id} className={`plan-guide-modal__item${checked ? ' is-checked' : ''}`}>
                    <label className="plan-guide-modal__row">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggle(t.id)}
                        aria-label={`选择 ${t.title || '(无标题)'}`}
                      />
                      <span className={`plan-guide-modal__prio plan-guide-modal__prio--${t.priority ?? 'very-low'}`} aria-hidden="true">
                        {t.priority && t.priority !== 'very-low' ? PRIORITY_LABEL[t.priority] : ''}
                      </span>
                      <span className="plan-guide-modal__title">{t.title || '(无标题)'}</span>
                      {t.dueAt && (
                        <span className="plan-guide-modal__due">{formatDue(t.dueAt)}</span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="plan-guide-modal__footer">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={doSnooze}
          >
            改天再提醒
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={doSkip}
          >
            跳过
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || noCandidates || selected.size === 0}
            onClick={doConfirm}
          >
            {selected.size > 0 ? `确认（${selected.size}）` : '确认'}
          </button>
        </footer>
      </div>
    </div>
  );
};

/** Local-date YYYY-MM-DD. Exported for callers (App.tsx + notification
 *  scheduler) so they stamp lastPlanGuideDate / plannedFor with the same
 *  key format the modal itself uses. */
export function todayDateKey(d: Date = new Date()): string {
  return todayKey(d);
}
