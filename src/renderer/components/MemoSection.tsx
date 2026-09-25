// 备忘录区 —— 第三个 <section>，渲染在 TodoListPane 的「全部任务」下面，
// 与今日待办 / 全部任务 同构（VSCode 风格 section-toggle + 平滑折叠）。
//
// 这一节是「拖入的碎片」的中间站：用户拖进来的内容（桌面宠物 / AI 输入框 /
// 全局快捷捕获）在落点不明时存到这里，避免强行做「是记录 / 是任务 / 是进展」
// 的猜测。详情页（#memo/:id）支持三种整理动作：
//   - 并入任务   → 合并到既有任务的 progress 文档（memo 本身删除）
//   - 生成任务   → 把 memo 提升为新任务（memo 本身删除）
//   - 标记为记录 → 把 memo 折叠进「已整理」区，保留为参考
//
// UI 结构（与 planned-section / other-section 对齐）：
//   <section.memo-section>
//     <button.section-toggle>  折叠 / 展开
//     <div.section-collapse>
//       <ul.memo-list>
//         <li.memo-row>  预览 + ⋮ 菜单 + 附件数 / 来源 chip
//
// 已整理（resolvedAt != null）默认折叠在底部小节里 —— useMemos(includeResolved=true)
// 才拉出，避免主列表被长尾占用。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMemos, useTodos } from '../hooks/useTodoListApi';
import type { Memo, Todo, ULID } from '../../shared/todo-types';
import { IconChevronDown, IconAttach } from './icons';

export const MemoSection: React.FC<{
  selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ selectedId, onSelect }) => {
  const { data, loading, refresh } = useMemos(false);
  const [collapsed, setCollapsed] = useState(false);

  // 没有任何 memo 时整段不渲染 —— 与 planned-section / other-section
  // 行为一致（它们在 rootTasks.length === 0 时也不渲染）。
  const isEmpty = !loading && data.length === 0;
  if (isEmpty && !collapsed) {
    // 空态：仍然渲染 header（用户可能想了解「拖到哪儿」），但不展开列表。
    return (
      <section className="memo-section" aria-label="备忘录">
        <button
          type="button"
          className="memo-section__header section-toggle"
          aria-expanded={false}
          aria-controls="memo-section-list"
          onClick={() => setCollapsed((v) => !v)}
        >
          <IconChevronDown size={12} className="section-toggle__chevron" />
          <span className="memo-section__title">备忘录</span>
          <span className="memo-section__count">0</span>
          <span className="memo-section__hint" aria-hidden="true">拖到这里暂存碎片</span>
        </button>
      </section>
    );
  }

  const visibleCount = data.length;

  return (
    <section className="memo-section" aria-label="备忘录">
      <button
        type="button"
        className="memo-section__header section-toggle"
        aria-expanded={!collapsed}
        aria-controls="memo-section-list"
        onClick={() => setCollapsed((v) => !v)}
      >
        <IconChevronDown size={12} className="section-toggle__chevron" />
        <span className="memo-section__title">备忘录</span>
        <span className="memo-section__count">{visibleCount}</span>
      </button>
      <div
        id="memo-section-list"
        className={`section-collapse${collapsed ? ' is-collapsed' : ''}`}
        aria-hidden={collapsed}
      >
        {loading && data.length === 0 ? (
          <div className="task-list__hint">加载中…</div>
        ) : (
          <ul className="memo-section__list">
            {data.map((m) => (
              <MemoRow
                key={m.id}
                memo={m}
                active={m.id === selectedId}
                onSelect={onSelect}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// 单行 —— 复用 task-row 的视觉骨架（task-row__main + meta-pills）以保持整列
// 视觉一致，但行的 glyph 与 chips 是 memo 专用的。
// ⋮ 菜单在 hover 行 / 焦点行时出现在右侧；菜单项：编辑 / 生成任务 / 并入任务… /
// 标记为记录 / 删除。

const MemoRow: React.FC<{
  memo: Memo;
  active: boolean;
  onSelect: (id: string) => void;
  onChanged: () => void;
}> = ({ memo, active, onSelect, onChanged }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 关闭菜单的全局监听 —— 点击菜单外 / Esc 都关。
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onDelete = useCallback(async () => {
    const res = await window.todoList.memo.remove(memo.id);
    if (!res.ok) {
      // 不阻塞菜单 —— 失败在下一次 refresh 时仍会通过 broadcast 体现。
      console.warn('memo.remove failed:', res.message ?? res.code);
    }
    setMenuOpen(false);
    onChanged();
  }, [memo.id, onChanged]);

  const onPromote = useCallback(async () => {
    const res = await window.todoList.memo.promoteToTask(memo.id);
    setMenuOpen(false);
    if (!res.ok) {
      console.warn('memo.promoteToTask failed:', res.message ?? res.code);
      return;
    }
    // 跳转到新任务详情。
    const data = res.data as { todoId: ULID };
    onSelect(data.todoId);
    onChanged();
  }, [memo.id, onSelect, onChanged]);

  const onMarkResolved = useCallback(async () => {
    const res = await window.todoList.memo.markResolved(memo.id, true);
    setMenuOpen(false);
    if (!res.ok) {
      console.warn('memo.markResolved failed:', res.message ?? res.code);
      return;
    }
    onChanged();
  }, [memo.id, onChanged]);

  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row memo-row${active ? ' is-active' : ''}`}
      data-source={memo.source}
      onClick={() => onSelect(memo.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(memo.id);
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          void onDelete();
        }
      }}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
          <span className="task-row__icon" aria-hidden="true">
            <MemoGlyph />
          </span>
          <span className="task-row__title memo-row__preview">{memo.preview || '(空白备忘录)'}</span>
        </div>
        <div className="task-row__meta-line">
          <div className="task-row__meta-pills">
            <span className={`memo-row__source memo-row__source--${memo.source}`}>
              {SOURCE_LABEL[memo.source]}
            </span>
            {memo.attachmentIds.length > 0 && (
              <span className="memo-row__attach" title={`${memo.attachmentIds.length} 个附件`}>
                <IconAttach size={11} />
                {memo.attachmentIds.length}
              </span>
            )}
          </div>
          <div className="task-row__actions" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="task-row__action memo-row__menu-btn"
              aria-label="备忘录操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="更多"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MenuGlyph />
            </button>
            {menuOpen && (
              <div className="memo-row__menu" role="menu">
                <button
                  type="button"
                  className="memo-row__menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelect(memo.id);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="memo-row__menu-item"
                  role="menuitem"
                  onClick={() => void onPromote()}
                >
                  生成任务
                </button>
                <button
                  type="button"
                  className="memo-row__menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setPickerOpen(true);
                  }}
                >
                  并入任务…
                </button>
                <button
                  type="button"
                  className="memo-row__menu-item"
                  role="menuitem"
                  onClick={() => void onMarkResolved()}
                >
                  标记为记录
                </button>
                <div className="memo-row__menu-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="memo-row__menu-item memo-row__menu-item--danger"
                  role="menuitem"
                  onClick={() => void onDelete()}
                >
                  删除
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {pickerOpen && (
        <MergeTaskPicker
          memoId={memo.id}
          onClose={() => setPickerOpen(false)}
          onMerged={() => {
            setPickerOpen(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// 「并入任务…」选择器 —— 模态：搜索框 + 任务列表。点击任务调 memo.mergeIntoTask。
// 比原生 <select> 友好得多（任务可能上千条），且支持 Esc 取消 / Enter 选首个。

const MergeTaskPicker: React.FC<{
  memoId: string;
  onClose: () => void;
  onMerged: () => void;
}> = ({ memoId, onClose, onMerged }) => {
  // 拉所有未归档 / 未删除的任务作为候选 —— mergeIntoTask 接受任何状态，但
  // UI 上隐藏归档 / 删除避免误合并到不会回来看的任务。
  const { data: allTodos } = useTodos({});
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (allTodos as Todo[])
      .filter((t) => !t.archivedAt && !t.deletedAt)
      .filter((t) => !q || (t.title || '').toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
      .slice(0, 30);
  }, [allTodos, search]);

  const onPick = useCallback(
    async (todoId: ULID) => {
      setBusy(true);
      const res = await window.todoList.memo.mergeIntoTask(memoId, todoId);
      setBusy(false);
      if (!res.ok) {
        console.warn('memo.mergeIntoTask failed:', res.message ?? res.code);
        return;
      }
      onMerged();
    },
    [memoId, onMerged],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && candidates.length > 0 && !busy) {
      e.preventDefault();
      void onPick(candidates[0].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="memo-picker__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="选择目标任务"
      onClick={onClose}
    >
      <div className="memo-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="search"
          className="memo-picker__input"
          placeholder="搜索任务标题…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <ul className="memo-picker__list">
          {candidates.length === 0 ? (
            <li className="memo-picker__empty">没有匹配的任务</li>
          ) : (
            candidates.map((t) => (
              <li
                key={t.id}
                className="memo-picker__item"
                role="button"
                tabIndex={0}
                onClick={() => void onPick(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onPick(t.id);
                }}
              >
                {t.title || '(无标题)'}
              </li>
            ))
          )}
        </ul>
        <div className="memo-picker__footer">
          <span>回车选首个 · Esc 取消</span>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Glyphs —— memo 用「便签纸」图标（带折角），与任务行的 document / folder
// 图标同 14×14 描边家族。

const MemoGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 1.5h6L12.5 4.5v10a.5.5 0 01-.5.5h-8.5a.5.5 0 01-.5-.5v-12.5a.5.5 0 01.5-.5z"
      fill="var(--accent-primary-soft)"
      stroke="var(--accent-primary)"
      strokeWidth="1" />
    <path d="M9 1.5V4.5h3"
      fill="none" stroke="var(--accent-primary)"
      strokeWidth="1" strokeLinejoin="round" />
    <path d="M5 7.5h6M5 9.8h6M5 12h4"
      stroke="var(--accent-primary)" strokeWidth="0.9" strokeLinecap="round" opacity="0.6" />
  </svg>
);

const MenuGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="4" cy="8" r="1.1" fill="currentColor" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    <circle cx="12" cy="8" r="1.1" fill="currentColor" />
  </svg>
);

const SOURCE_LABEL: Record<Memo['source'], string> = {
  drop: '拖入',
  clipboard: '剪贴板',
  capture: '捕获',
  manual: '手动',
};
