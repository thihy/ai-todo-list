// Task list — left column of the master-detail layout. Renders a pure
// Task tree: every entry is a Task; a Task may have SubTasks (nested via
// parentId). Root tasks (parentId === null) sit at the top; their subtasks
// nest underneath, recursively. There is no longer a separate "Group"
// concept — everything is a Task.
//
// Tree behaviour:
//   - Indentation by nesting depth, driven by the `--row-depth` CSS custom
//     property so SubTasks visibly nest under their parent.
//   - Single-click selects; double-click toggles expand/collapse (so you
//     can stay on the same row and drill in). The chevron after the status
//     glyph also toggles.
//   - A Task with SubTasks shows a folder-style glyph instead of the leaf
//     document glyph (same 14×14 stroke family). The subtitle shows the
//     subtask progress ratio (done/total).
//   - Header has collapse-all / expand-all controls (only useful once the
//     tree has branches).
//   - Hover a row to reveal a trash button for quick delete; Delete key on
//     a focused row does the same.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTodos } from '../hooks/useThihyApi';
import type { ListFilter, SortKey } from '../router';
import { ToastHost } from '../components/Toast';
import type { ToastBus } from '../components/Toast';
import type { Todo, TodoStatus, ULID } from '../../shared/todo-types';
import { UserMenu } from '../components/UserMenu';
import { StatusSelect } from '../components/StatusSelect';
import { IconCalendar, IconDrawing } from '../components/icons';

export const TodoListPane: React.FC<{
  width: number;
  filter: ListFilter;
  sort: SortKey;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
  toastBus: ToastBus;
}> = ({ width, filter, sort, selectedId, onSelect, onOpenSettings, onCompose, toastBus }) => {
  const repoFilter = filterToRepoFilter(filter);
  const { data, loading, refresh } = useTodos(repoFilter);

  // Auto-refresh when a new todo is created elsewhere (capture window, AI).
  useEffect(() => {
    const off = window.thihy.on('app:todo-created', () => {
      void refresh();
    });
    return off;
  }, [refresh]);

  // Expand/collapse state is lifted here (not per-TaskBranch) so the
  // collapse-all / expand-all header buttons can drive the whole tree.
  // Default is EXPANDED (absent key = true), so clearing the map = all
  // expanded; collapse-all seeds every branching task id with false.
  const [expandMap, setExpandMap] = useState<Record<string, boolean>>({});
  const getExpanded = useCallback((id: string) => expandMap[id] ?? true, [expandMap]);
  const toggleExpanded = useCallback((id: string) => {
    setExpandMap((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }, []);

  // ids of every task that HAS subtasks — needed for collapse-all (seed
  // them all false) and to decide whether the header controls are useful.
  const branchIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of data) if (t.parentId) set.add(t.parentId);
    return set;
  }, [data]);

  const expandAll = useCallback(() => setExpandMap({}), []);
  const collapseAll = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const id of branchIds) next[id] = false;
    setExpandMap(next);
  }, [branchIds]);

  // In the 归档 view the per-row hover button restores (un-archives) instead
  // of deleting. Restore = clear archived_at; the task drops back into the
  // active list.
  const archivedView = filter.kind === 'archived';
  // 已删除 view: the quick-recovery bin. Rows here are soft-deleted; the
  // per-row action is 恢复 (clear deleted_at on the subtree), not delete.
  const deletedView = filter.kind === 'deleted';
  const onRestore = useCallback(async (id: string) => {
    await window.thihy.todo.restore(id);
    await refresh();
  }, [refresh]);

  // Quick-recovery: soft-deleting a task from the active list pops a 5-min
  // toast with a 恢复 action. No confirmation — the delete is immediate
  // (logical, always undoable). The toast auto-dismisses after 5 min; the
  // task is still recoverable from the 已删除 filter view after that.
  const onDelete = useCallback(async (id: string) => {
    const todo = data.find((t) => t.id === id);
    await window.thihy.todo.delete(id);
    await refresh();
    if (todo) {
      toastBus.push({
        kind: 'info',
        message: `已删除「${todo.title || '(无标题)'}」`,
        ttl: 5 * 60_000,
        action: {
          label: '恢复',
          run: () => {
            void window.thihy.todo.restore(id).then(() => refresh());
          },
        },
      });
    }
  }, [refresh, data, toastBus]);

  // Root tasks: top-level (no parentId). SubTasks nest under their parent
  // via TaskBranch, so the root list is just the parentId === null set.
  // The repo orders by updated_at DESC, but the user-facing sort (字母顺序
  // by default, or 创建日期 / 截止日期 / 优先级) is applied here in the
  // renderer because the tree is assembled client-side from the fetched set.
  const rootTasks = useMemo(
    () => sortTodos(data.filter((t) => !t.parentId), sort),
    [data, sort],
  );
  // 已删除 view: deletion-roots = deleted tasks whose parent is NOT itself
  // deleted (or has no parent). Because delete() cascades to the subtree, a
  // deleted parent carries its descendants with it; showing only roots avoids
  // listing a child twice and avoids the orphan case where restoring a child
  // alone would leave it dangling under a still-deleted parent. Restoring a
  // root restores the whole subtree (repo.restore cascades). Sorted by
  // deletion time DESC (newest deletion first), per the user's spec.
  const deletedRoots = useMemo(() => {
    if (!deletedView) return [] as Todo[];
    const deletedIds = new Set(data.map((t) => t.id));
    return data
      .filter((t) => !t.parentId || !deletedIds.has(t.parentId))
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }, [data, deletedView]);
  const isEmpty = !loading && data.length === 0;
  return (
    <section className="task-list" aria-label="任务列表" style={{ width }}>
      <header className="task-list__header">
        <button type="button" className="task-list__add-btn" onClick={onCompose}>
          <PlusGlyph /> 新建任务
        </button>
        {branchIds.size > 0 && (
          <div className="task-list__tools">
            <button type="button" className="task-list__tool-btn" onClick={expandAll} title="全部展开" aria-label="全部展开">
              <ExpandAllGlyph />
            </button>
            <button type="button" className="task-list__tool-btn" onClick={collapseAll} title="全部折叠" aria-label="全部折叠">
              <CollapseAllGlyph />
            </button>
          </div>
        )}
      </header>

      <div className="task-list__body">
        <>
          {loading && data.length === 0 && (
            <div className="task-list__hint">加载中…</div>
          )}
          {isEmpty && !deletedView && (
            <div className="task-list__empty">
              <div className="task-list__empty-glyph" aria-hidden="true">📭</div>
              <div>暂无任务</div>
              <div className="task-list__empty-hint">
                点击上方「新建任务」输入，或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 快速捕获
              </div>
            </div>
          )}
          {isEmpty && deletedView && (
            <div className="task-list__empty">
              <div className="task-list__empty-glyph" aria-hidden="true">🗑</div>
              <div>回收站为空</div>
              <div className="task-list__empty-hint">
                删除的任务会暂存于此，可随时恢复
              </div>
            </div>
          )}

          {deletedView ? (
            deletedRoots.length > 0 && (
              <ul className="task-list__root-tasks">
                {deletedRoots.map((t) => (
                  <DeletedRow
                    key={t.id}
                    todo={t}
                    active={t.id === selectedId}
                    descendantCount={countDescendants(data, t.id)}
                    onSelect={onSelect}
                    onRestore={onRestore}
                  />
                ))}
              </ul>
            )
          ) : (
            rootTasks.length > 0 && (
              <ul className="task-list__root-tasks">
                {rootTasks.map((t) => (
                  <TaskBranch
                    key={t.id}
                    todo={t}
                    depth={0}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    allTodos={data}
                    sort={sort}
                    getExpanded={getExpanded}
                    toggleExpanded={toggleExpanded}
                    archivedView={archivedView}
                    onCycle={async (next) => {
                      await window.thihy.todo.update(t.id, { status: next });
                      await refresh();
                    }}
                    onDelete={onDelete}
                    onRestore={onRestore}
                  />
                ))}
              </ul>
            )
          )}
        </>
      </div>

      <footer className="task-list__footer">
        <UserMenu onOpenSettings={onOpenSettings} />
      </footer>

      {/* Toasts anchor to the bottom of this task-list column (stacked upward
          above the footer) — not a global bottom-right overlay. */}
      <ToastHost bus={toastBus} />
    </section>
  );
};

// ----- Task row (with SubTask nesting) -----

/** Count the descendants of `rootId` within `all` (the deleted slice in the
 *  已删除 view). Walks the parent_id tree downward; O(n) per root but n is
 *  the deleted slice, which stays small. Used for the "N 子任务" chip on a
 *  DeletedRow so the user knows restoring a root brings back its branch. */
function countDescendants(all: Todo[], rootId: ULID): number {
  const byParent = new Map<string, Todo[]>();
  for (const t of all) {
    if (!t.parentId) continue;
    const arr = byParent.get(t.parentId);
    if (arr) arr.push(t);
    else byParent.set(t.parentId, [t]);
  }
  let n = 0;
  const stack = [rootId];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const c of byParent.get(pid) ?? []) {
      n++;
      stack.push(c.id);
    }
  }
  return n;
}

// Sort a slice of todos by the user's chosen key. Default 字母顺序 is
// Chinese-aware (localeCompare with numeric ordering so "task2" < "task10")
// and case-insensitive; the other keys order by the natural direction for
// each: 创建日期 newest-first, 截止日期 soonest-first (no-due last), 优先级
// high→none. The comparator is stable-ish (no tiebreak beyond the key), which
// is fine — siblings of equal key keep their fetched (updated_at DESC) order.
const PRIORITY_WEIGHT: Record<Todo['priority'], number> = { high: 4, medium: 3, low: 2, none: 1 };

function sortTodos(todos: Todo[], sort: SortKey): Todo[] {
  // Slice first so we never mutate the hook's cached array.
  const arr = todos.slice();
  switch (sort) {
    case 'alpha':
      arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
      break;
    case 'created':
      arr.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'due':
      // Soonest first; no due date sinks to the bottom of the branch.
      arr.sort((a, b) => {
        if (a.dueAt == null && b.dueAt == null) return 0;
        if (a.dueAt == null) return 1;
        if (b.dueAt == null) return -1;
        return a.dueAt - b.dueAt;
      });
      break;
    case 'priority':
      arr.sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]);
      break;
  }
  return arr;
}

/** Walk the allTodos list to find direct subtasks of `parent`. SubTasks are
 *  tasks whose parentId points at `parent`. We filter in renderer code (not
 *  repo) so the entire SubTask subtree is computed from the already-fetched
 *  todo list without an extra round-trip per parent. The result is sorted by
 *  the current sort key (same comparator as root tasks) so a nested branch
 *  reads in the same order as the top-level list. */
function subtasksOf(allTodos: Todo[], parent: ULID, sort: SortKey): Todo[] {
  return sortTodos(allTodos.filter((t) => t.parentId === parent), sort);
}

const TaskBranch: React.FC<{
  todo: Todo;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allTodos: Todo[];
  sort: SortKey;
  getExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  archivedView: boolean;
  onCycle: (next: TodoStatus) => Promise<void>;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}> = ({ todo, depth, selectedId, onSelect, allTodos, sort, getExpanded, toggleExpanded, archivedView, onCycle, onDelete, onRestore }) => {
  const children = subtasksOf(allTodos, todo.id, sort);
  const hasSubtasks = children.length > 0;
  const doneCount = hasSubtasks ? children.filter((c) => c.status === 'done').length : 0;
  const expanded = getExpanded(todo.id);

  return (
    <>
      <TaskRow
        todo={todo}
        depth={depth}
        active={todo.id === selectedId}
        onSelect={onSelect}
        onCycle={onCycle}
        hasSubtasks={hasSubtasks}
        subtaskCount={children.length}
        subtaskDoneCount={doneCount}
        subtasksExpanded={expanded}
        onToggleSubtasks={() => toggleExpanded(todo.id)}
        archivedView={archivedView}
        onDelete={() => onDelete(todo.id)}
        onRestore={() => onRestore(todo.id)}
      />
      {hasSubtasks && expanded && (
        <ul className="task-branch__children">
          {children.map((c) => (
            <TaskBranch
              key={c.id}
              todo={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              allTodos={allTodos}
              sort={sort}
              getExpanded={getExpanded}
              toggleExpanded={toggleExpanded}
              archivedView={archivedView}
              onCycle={async (next) => {
                await window.thihy.todo.update(c.id, { status: next });
              }}
              onDelete={onDelete}
              onRestore={onRestore}
            />
          ))}
        </ul>
      )}
    </>
  );
};

const TaskRow: React.FC<{
  todo: Todo;
  depth: number;
  active: boolean;
  onSelect: (id: string) => void;
  onCycle: (next: TodoStatus) => Promise<void>;
  hasSubtasks: boolean;
  subtaskCount: number;
  subtaskDoneCount: number;
  subtasksExpanded: boolean;
  onToggleSubtasks: () => void;
  archivedView: boolean;
  onDelete: () => void;
  onRestore: () => void;
}> = ({ todo, depth, active, onSelect, onCycle, hasSubtasks, subtaskCount, subtaskDoneCount, subtasksExpanded, onToggleSubtasks, archivedView, onDelete, onRestore }) => {
  const st = todo.status;
  // Terminal/voided states recede (icon mutes, title strikes); blocked is still
  // active but flagged. Each off-default status gets its own row class so the
  // list reads at a glance: done = cleared, cancelled = voided, blocked = needs attention.
  const recede = st === 'done' || st === 'cancelled';
  const statusCls = st === 'done' ? ' is-done' : st === 'cancelled' ? ' is-cancelled' : st === 'blocked' ? ' is-blocked' : '';
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}${statusCls}`}
      style={{ '--row-depth': depth } as React.CSSProperties}
      onClick={() => onSelect(todo.id)}
      onDoubleClick={(e) => {
        // Double-click toggles expand/collapse WITHOUT deselecting/navigating
        // away — the first click already selected the row. Only meaningful
        // for branching tasks; leaf tasks have nothing to toggle.
        if (hasSubtasks) {
          e.stopPropagation();
          onToggleSubtasks();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(todo.id);
        // Quick delete: Delete/Backspace on a focused row.
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onDelete();
        }
      }}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
          {/* Glyph: leaf tasks get a document icon; tasks WITH subtasks get
              a folder-style icon of the same 14×14 stroke family so the
              tree reads as one icon set. Done tasks mute. */}
          <span className="task-row__icon" aria-hidden="true">
            {hasSubtasks ? <TaskBranchGlyph open={subtasksExpanded} done={recede} /> : <TaskGlyph done={recede} />}
          </span>
          <span className="task-row__title">{todo.title || '(无标题)'}</span>
          {/* SubTask collapse/expand chevron — sits right AFTER the title
              (before the status dot) so it reads "name ▸ status". Only
              rendered when this task actually has subtasks. */}
          {hasSubtasks && (
            <button
              type="button"
              className="task-row__toggle"
              aria-label={subtasksExpanded ? '折叠子任务' : '展开子任务'}
              aria-expanded={subtasksExpanded}
              title={subtasksExpanded ? '折叠子任务' : '展开子任务'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSubtasks();
              }}
            >
              <ChevronGlyph open={subtasksExpanded} />
            </button>
          )}
          <StatusSelect status={todo.status} onChange={onCycle} variant="icon" />
          {/* Per-row action — revealed on hover. In the active list it's
              quick delete; in the 归档 view it's restore (un-archive). */}
          {archivedView ? (
            <button
              type="button"
              className="task-row__action task-row__restore"
              aria-label="恢复任务"
              title="恢复（移回归档前）"
              onClick={(e) => {
                e.stopPropagation();
                onRestore();
              }}
            >
              <RestoreGlyph />
            </button>
          ) : (
            <button
              type="button"
              className="task-row__action task-row__delete"
              aria-label="删除任务"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <TrashGlyph />
            </button>
          )}
        </div>
        <Subtitle todo={todo} subtaskCount={subtaskCount} subtaskDoneCount={subtaskDoneCount} />
      </div>
    </li>
  );
};

const Subtitle: React.FC<{ todo: Todo; subtaskCount: number; subtaskDoneCount: number }> = ({ todo, subtaskCount, subtaskDoneCount }) => {
  const bits: React.ReactNode[] = [];
  // Priority is rendered as a small colored chip next to the other metadata.
  // "none" priority is suppressed (it's the default — would just add noise).
  if (todo.priority && todo.priority !== 'none') {
    bits.push(
      <span key="p" className={`task-row__prio task-row__prio--${todo.priority}`} title={`优先级：${PRIORITY_LABEL[todo.priority]}`}>
        <span className="task-row__prio-dot" aria-hidden="true" />
        {PRIORITY_LABEL[todo.priority]}
      </span>,
    );
  }
  if (todo.progress != null && todo.progress > 0) {
    bits.push(
      <span key="prog" className="task-row__progress" title={`进度 ${todo.progress}%`}>
        <span className="task-row__progress-track" aria-hidden="true">
          <span className="task-row__progress-fill" style={{ width: `${todo.progress}%` }} />
        </span>
        <span className="task-row__progress-label">{todo.progress}%</span>
      </span>,
    );
  }
  if (todo.dueAt) {
    bits.push(
      <span key="d" className="task-row__due">
        <IconCalendar size={11} className="task-row__due-icon" />
        {formatDate(todo.dueAt)}
      </span>,
    );
  }
  if (todo.tags?.length) {
    todo.tags.slice(0, 3).forEach((tag) => bits.push(<span key={`t-${tag}`} className="task-row__tag">#{tag}</span>));
  }
  if (todo.drawingIds && todo.drawingIds.length > 0) {
    bits.push(
      <span key="dr" className="task-row__drawings">
        <IconDrawing size={11} className="task-row__drawings-icon" />
        {todo.drawingIds.length}
      </span>,
    );
  }
  // Subtask progress: "done/total 子任务". When all subtasks are done the
  // chip uses the success colour so a glance tells you the branch is clear.
  if (subtaskCount > 0) {
    const allDone = subtaskDoneCount === subtaskCount;
    bits.push(
      <span key="sub" className={allDone ? 'task-row__sub--done' : undefined}>
        {subtaskDoneCount}/{subtaskCount} 子任务
      </span>,
    );
  }
  if (bits.length === 0) return <div className="task-row__sub task-row__sub--empty">无附加信息</div>;
  return <div className="task-row__sub">{bits}</div>;
};

const PRIORITY_LABEL: Record<NonNullable<Todo['priority']>, string> = {
  high: '高',
  medium: '中',
  low: '低',
  none: '无',
};

// ----- Glyphs -----

const ChevronGlyph: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
    <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// TaskGlyph — a document/file glyph. 14×14, fill+stroke pattern (soft accent
// fill, accent stroke, 1px stroke). `done` mutes the glyph so completed
// tasks visually recede.
const TaskGlyph: React.FC<{ done: boolean }> = ({ done }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 1.5h6L12.5 4.5v10a.5.5 0 01-.5.5h-8.5a.5.5 0 01-.5-.5v-12.5a.5.5 0 01.5-.5z"
      fill={done ? 'transparent' : 'var(--accent-primary-soft)'}
      stroke={done ? 'var(--fg-muted)' : 'var(--accent-primary)'}
      strokeWidth="1" />
    <path d="M9 1.5V4.5h3"
      fill="none"
      stroke={done ? 'var(--fg-muted)' : 'var(--accent-primary)'}
      strokeWidth="1" strokeLinejoin="round" />
  </svg>
);

// TaskBranchGlyph — folder glyph for tasks that HAVE subtasks. Same 14×14
// stroke family as TaskGlyph so folders and leaves read as one icon set.
// `open` rotates the tab to indicate expanded vs collapsed; `done` mutes.
const TaskBranchGlyph: React.FC<{ open: boolean; done: boolean }> = ({ open, done }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
    style={{ transition: 'transform .12s' }}>
    <path d="M1.5 4.5h4l1.2 1.4h7.3a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V4.5z"
      fill={done ? 'transparent' : 'var(--accent-primary-soft)'}
      stroke={done ? 'var(--fg-muted)' : 'var(--accent-primary)'}
      strokeWidth="1" strokeLinejoin="round" />
    {/* folder tab — flips up when open, same as a classic file explorer */}
    <path d="M5.5 4.5L6.7 5.9"
      fill="none"
      stroke={done ? 'var(--fg-muted)' : 'var(--accent-primary)'}
      strokeWidth="1" strokeLinecap="round"
      style={{ transform: open ? 'translateY(0)' : 'none' }} />
  </svg>
);

const PlusGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const TrashGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3.2a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1.3M5 4.5l.6 8.3a.5.5 0 00.5.5h3.8a.5.5 0 00.5-.5L11 4.5"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

// Restore (un-archive) — a box-with-up-arrow, the inverse of archiving.
const RestoreGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 11.5V3.8M8 3.8L5 6.8M8 3.8L11 6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M3 10v2.2a.8.8 0 00.8.8h8.4a.8.8 0 00.8-.8V10"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
  </svg>
);

const ExpandAllGlyph: React.FC = () => (
  // Double downward chevron — "open every branch downward".
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 5l4 4 4-4M4 9.5l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CollapseAllGlyph: React.FC = () => (
  // Double upward chevron — "fold every branch upward".
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 11l4-4 4 4M4 6.5l4-4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// DeletedRow — a flat row in the 已删除 recovery bin. Simpler than TaskRow:
// no tree nesting (delete() cascades to the subtree, so only deletion-roots
// are shown), no status-cycle button. The single action is 恢复 (clears
// deleted_at on the whole subtree via repo.restore). Shows a "N 子任务" chip
// when the deleted branch had descendants so the user knows restore brings
// them all back. Reuses task-row styling so the bin reads as the same list.
const DeletedRow: React.FC<{
  todo: Todo;
  active: boolean;
  descendantCount: number;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
}> = ({ todo, active, descendantCount, onSelect, onRestore }) => {
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}`}
      onClick={() => onSelect(todo.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(todo.id);
      }}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
          <span className="task-row__icon" aria-hidden="true">
            <TaskGlyph done={false} />
          </span>
          <span className="task-row__title">{todo.title || '(无标题)'}</span>
          {descendantCount > 0 && (
            <span className="task-row__sub--done">{descendantCount} 子任务</span>
          )}
          <span className="task-row__deleted-time">{formatDateTime(todo.deletedAt)}</span>
          <button
            type="button"
            className="task-row__action task-row__restore task-row__restore--bin"
            aria-label="恢复任务"
            title="恢复（移回列表）"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(todo.id);
            }}
          >
            <RestoreGlyph /> 恢复
          </button>
        </div>
      </div>
    </li>
  );
};

function filterToRepoFilter(f: ListFilter): Parameters<typeof window.thihy.todo.list>[0] {
  switch (f.kind) {
    case 'all': return {};
    case 'today': return { dueBefore: endOfToday(), dueAfter: startOfToday() };
    case 'next7': return { dueBefore: Date.now() + 7 * 24 * 3600_000, dueAfter: startOfToday() };
    case 'archived': return { archivedOnly: true };
    case 'deleted': return { deletedOnly: true };
    case 'project': return { tag: [f.tag] };
    case 'status': return { status: [f.status as TodoStatus] };
    case 'priority': return { priority: [f.priority as Todo['priority']] };
  }
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
/** Full timestamp for the 已删除 bin — the deletion moment matters (sorted
 *  by it), so show date + HH:MM, not just the M/D used for due dates. */
function formatDateTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
