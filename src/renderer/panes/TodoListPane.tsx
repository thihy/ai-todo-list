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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTodos } from '../hooks/useTodoListApi';
import type { ListFilter, SortKey } from '../router';
import { ToastHost } from '../components/Toast';
import type { ToastBus } from '../components/Toast';
import type { Todo, TodoStatus, ULID } from '../../shared/todo-types';
import { UserMenu } from '../components/UserMenu';
import { StatusSelect } from '../components/StatusSelect';
import { IconCalendar, IconCollapseBar, IconDrawing, IconInboxEmpty, IconTrash } from '../components/icons';
import { todayDateKey } from '../components/PlanGuideModal';

export const TodoListPane: React.FC<{
  width: number;
  filter: ListFilter;
  sort: SortKey;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
  onCollapse?: () => void;
  toastBus: ToastBus;
}> = ({ width, filter, sort, selectedId, onSelect, onOpenSettings, onCompose, onCollapse, toastBus }) => {
  const repoFilter = filterToRepoFilter(filter);
  const { data, loading, refresh } = useTodos(repoFilter);

  // Auto-refresh when a new todo is created elsewhere (capture window, AI).
  useEffect(() => {
    const off = window.todoList.on('app:todo-created', () => {
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

  // 上半区独立展开态 —— 默认展开（与 expandMap 相同语义），但 key 在自己的
  // 命名空间里。折叠/展开上半区任务树不会影响下半区，反之亦然。否则上
  // 半区收起一个任务，下半区同一个任务也跟着收起 —— 视觉割裂。
  const [plannedExpandMap, setPlannedExpandMap] = useState<Record<string, boolean>>({});
  const getPlannedExpanded = useCallback(
    (id: string) => plannedExpandMap[id] ?? true,
    [plannedExpandMap],
  );
  const togglePlannedExpanded = useCallback((id: string) => {
    setPlannedExpandMap((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
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

  // — Single toggle that replaces the old expand-all / collapse-all pair —
  // One click flips between the two extremes: if every branching task is
  // currently expanded, click collapses all; otherwise click expands all.
  // Tracked separately from branchIds so the button stays "expand-all" while
  // data is still loading (no branching tasks yet → ambiguous). Once any
  // branch is collapsed the next click re-opens everything; once everything
  // is open it folds the tree flat.
  const allExpanded = branchIds.size > 0 && Array.from(branchIds).every((id) => getExpanded(id));
  const toggleAll = useCallback(() => {
    if (allExpanded) collapseAll();
    else expandAll();
  }, [allExpanded, collapseAll, expandAll]);

  // 创建子任务的入口已迁移到任务列表行尾（hover 行尾的 + 按钮）。这里聚合
  // IPC 调用、强制展开父节点、刷新列表 —— 把"创建后的可见性"问题一次性
  // 在顶层解决，避免每个 TaskBranch 自己持有 expandMap 的引用。
  const onCreateSubtask = useCallback(
    async (parentId: string, title: string): Promise<boolean> => {
      const res = await window.todoList.todo.create({ parentId, title });
      if (!res.ok) return false;
      // 父节点可能处于折叠态；强制展开以展示新子任务，否则用户连"创建成功"
      // 都看不到。refresh 重新拉 data，children ul 同步出现。
      setExpandMap((prev) => ({ ...prev, [parentId]: true }));
      await refresh();
      return true;
    },
    [refresh],
  );

  // In the 归档 view the per-row hover button restores (un-archives) instead
  // of deleting. Restore = clear archived_at; the task drops back into the
  // active list.
  const archivedView = filter.kind === 'archived';
  // 已删除 view: the quick-recovery bin. Rows here are soft-deleted; the
  // per-row action is 恢复 (clear deleted_at on the subtree), not delete.
  const deletedView = filter.kind === 'deleted';
  const onRestore = useCallback(async (id: string) => {
    await window.todoList.todo.restore(id);
    await refresh();
  }, [refresh]);

  // Quick-recovery: soft-deleting a task from the active list pops a 5-min
  // toast with a 恢复 action. No confirmation — the delete is immediate
  // (logical, always undoable). The toast auto-dismisses after 5 min; the
  // task is still recoverable from the 已删除 filter view after that.
  const onDelete = useCallback(async (id: string) => {
    const todo = data.find((t) => t.id === id);
    await window.todoList.todo.delete(id);
    await refresh();
    if (todo) {
      toastBus.push({
        kind: 'info',
        message: `已删除「${todo.title || '(无标题)'}」`,
        ttl: 5 * 60_000,
        action: {
          label: '恢复',
          run: () => {
            void window.todoList.todo.restore(id).then(() => refresh());
          },
        },
      });
    }
  }, [refresh, data, toastBus]);

  // —— 今日待办: plan / unplan ——
  // 加进今日：写入 plannedFor = 今天的本地日期串 'YYYY-MM-DD'（tz 稳定，
  // 不依赖 startOfToday 的 ms；跨午夜后旧 stamp 自然不匹配今天）。
  // 从今日剔除：显式 null。两者都走 todo.update 通道，触发
  // broadcastDataChanged，列表 + 详情双向刷新。
  const todayKey = useMemo(() => todayDateKey(), []);
  const onPlanToday = useCallback(
    async (id: string): Promise<void> => {
      await window.todoList.todo.update(id, { plannedFor: todayKey });
      await refresh();
      toastBus.push({ kind: 'success', message: '已加入今日', ttl: 1500 });
    },
    [todayKey, refresh, toastBus],
  );
  const onUnplan = useCallback(
    async (id: string): Promise<void> => {
      await window.todoList.todo.update(id, { plannedFor: null });
      await refresh();
      toastBus.push({ kind: 'success', message: '已从今日剔除', ttl: 1500 });
    },
    [refresh, toastBus],
  );

  // Root tasks: top-level (no parentId). SubTasks nest under their parent
  // via TaskBranch, so the root list is just the parentId === null set.
  // The repo orders by updated_at DESC, but the user-facing sort (字母顺序
  // by default, or 创建日期 / 截止日期 / 优先级) is applied here in the
  // renderer because the tree is assembled client-side from the fetched set.
  const rootTasks = useMemo(
    () => sortTodos(data.filter((t) => !t.parentId), sort),
    [data, sort],
  );
  // —— 今日待办 上半区的派生 ——
  // plannedFor 等于今天日期的任务 = 今日叶子；其祖先链（直系 parentId 向上）
  // 必须全部出现在上半区，下半区里同样的祖先节点会再次出现（key 冲突仅在同一
  // <ul> 下发生，两块 <ul> 是独立的）。兄弟任务（同一父下未被安排的子任务）
  // 被折叠到 peer-collapse chip，点击展开。
  const plannedSet = useMemo(() => {
    const set = new Set<string>();
    for (const t of data) if (t.plannedFor === todayKey) set.add(t.id);
    return set;
  }, [data, todayKey]);
  const byId = useMemo(() => {
    const m = new Map<string, Todo>();
    for (const t of data) m.set(t.id, t);
    return m;
  }, [data]);
  const shownSet = useMemo(() => {
    if (plannedSet.size === 0) return new Set<string>();
    const set = new Set<string>(plannedSet);
    for (const id of plannedSet) {
      let cur = byId.get(id);
      while (cur?.parentId) {
        set.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    }
    return set;
  }, [plannedSet, byId]);
  // 兄弟折叠态 —— 不复用 expandMap（控制"全部子任务可见"），独立 useState。
  // Key = parent id, value = 折叠/展开。仅当对应父下有未计划兄弟时才有意义。
  const [peerCollapseMap, setPeerCollapseMap] = useState<Record<string, boolean>>({});
  const getPeerExpanded = useCallback(
    (id: string) => peerCollapseMap[id] ?? false, // 默认折叠
    [peerCollapseMap],
  );
  const togglePeerExpanded = useCallback((id: string) => {
    setPeerCollapseMap((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  }, []);
  // 上半区要展示的根任务 = shownSet 里 parentId === null 的任务，按 sort 排序。
  const plannedRoots = useMemo(
    () => (shownSet.size === 0 ? [] : sortTodos(data.filter((t) => !t.parentId && shownSet.has(t.id)), sort)),
    [data, shownSet, sort],
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
            {/* Single toggle replaces the old expand-all / collapse-all pair.
                Glyph + label swap with state: when the tree is fully expanded
                the icon points to the action that FOLDS everything (collapse),
                and vice versa. aria-pressed communicates the current "all
                expanded" state for assistive tech; the visual glyph + title
                text describe the action, not the state, so the user reads it
                as an actionable control. */}
            <button
              type="button"
              className="task-list__tool-btn"
              onClick={toggleAll}
              title={allExpanded ? '全部折叠' : '全部展开'}
              aria-label={allExpanded ? '全部折叠' : '全部展开'}
              aria-pressed={allExpanded}
            >
              {allExpanded ? <CollapseAllGlyph /> : <ExpandAllGlyph />}
            </button>
          </div>
        )}
        {onCollapse && (
          /* Collapse affordance — same IconCollapseBar as the AI panel
             header, living ON the task list's own header (right edge) so
             the user sees it as part of the area they're looking at, not
             a handle on a separate divider column. Mirrors the AI panel
             pattern byte-for-byte: chrome button at the title row's far
             right, after the in-panel tools. */
          <button
            type="button"
            className="task-list__collapse-btn"
            onClick={onCollapse}
            title="收起任务列表"
            aria-label="收起任务列表"
          >
            <IconCollapseBar />
          </button>
        )}
      </header>

      <div className="task-list__body">
        <>
          {loading && data.length === 0 && (
            <div className="task-list__hint">加载中…</div>
          )}
          {isEmpty && !deletedView && (
            <div className="task-list__empty">
              <IconInboxEmpty size={28} className="task-list__empty-glyph" />
              <div>暂无任务</div>
              <div className="task-list__empty-hint">
                点击上方「新建任务」输入，或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 快速捕获
              </div>
            </div>
          )}
          {isEmpty && deletedView && (
            <div className="task-list__empty">
              <IconTrash size={28} className="task-list__empty-glyph" />
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
            <>
              {/* === 上半区：今日待办 === */}
              {/* 只有 active 列表才显示今日区；归档视图只显示归档行。 */}
              {!archivedView && plannedRoots.length > 0 && (
                <section className="planned-section" aria-label="今日待办">
                  <header className="planned-section__header">
                    <h2 className="planned-section__title">今日待办</h2>
                    <span className="planned-section__count">{plannedSet.size}</span>
                  </header>
                  <ul className="planned-section__list">
                    {plannedRoots.map((t) => (
                      <PlannedBranch
                        key={`planned-${t.id}`}
                        todo={t}
                        depth={0}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        allTodos={data}
                        sort={sort}
                        getExpanded={getPlannedExpanded}
                        toggleExpanded={togglePlannedExpanded}
                        todayKey={todayKey}
                        shownSet={shownSet}
                        getPeerExpanded={getPeerExpanded}
                        togglePeerExpanded={togglePeerExpanded}
                        onCycle={async (next) => {
                          await window.todoList.todo.update(t.id, { status: next });
                          await refresh();
                        }}
                        onDelete={onDelete}
                        onUnplan={onUnplan}
                        onCreateSubtask={onCreateSubtask}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {/* === 下半区：全部任务 === */}
              {/* 下半区展示完整任务树，已被安排到今日的子任务在该任务行有今日图标
                  标识（不影响任务本身是否还"完整"出现在下半区 —— 用户可以从下半区
                  直接看到所有任务，再叠加判断哪些今天要做）。 */}
              {rootTasks.length > 0 && (
                <section className="other-section" aria-label="全部任务">
                  <header className="other-section__header">
                    <h2 className="other-section__title">{archivedView ? '归档' : '全部任务'}</h2>
                    <span className="other-section__count">{rootTasks.length}</span>
                  </header>
                  <ul className="other-section__list task-list__root-tasks">
                    {rootTasks.map((t) => (
                      <TaskBranch
                        key={`other-${t.id}`}
                        todo={t}
                        depth={0}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        allTodos={data}
                        sort={sort}
                        getExpanded={getExpanded}
                        toggleExpanded={toggleExpanded}
                        archivedView={archivedView}
                        todayKey={todayKey}
                        shownSet={shownSet}
                        onCycle={async (next) => {
                          await window.todoList.todo.update(t.id, { status: next });
                          await refresh();
                        }}
                        onDelete={onDelete}
                        onRestore={onRestore}
                        onCreateSubtask={onCreateSubtask}
                        onPlanToday={onPlanToday}
                        onUnplan={onUnplan}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
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
  /** startOfToday() — 传给 TaskRow 用于判断行内是否展示今日图标 */
  todayKey: string;
  /** 上半区节点集合（今日叶子 + 祖先链）；用于祖先任务行内强制展示今日图标 */
  shownSet: Set<string>;
  onCycle: (next: TodoStatus) => Promise<void>;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  /** 创建子任务 —— 返回 true 表示 IPC 成功，调用方已展开父节点 + refresh。
   *  返回 false 表示失败，SubtaskCreateRow 保留 draft 并展示 is-error。 */
  onCreateSubtask: (parentId: string, title: string) => Promise<boolean>;
  /** 下半区行尾 "+ 今日" 按钮（仅下半区 TaskBranch 传；上半区 PlannedBranch 不传） */
  onPlanToday?: (id: string) => Promise<void>;
  /** 下半区把已计划任务的 "+ 今日" 切成"今天不做了"用 */
  onUnplan?: (id: string) => Promise<void>;
}> = ({ todo, depth, selectedId, onSelect, allTodos, sort, getExpanded, toggleExpanded, archivedView, todayKey, shownSet, onCycle, onDelete, onRestore, onCreateSubtask, onPlanToday, onUnplan }) => {
  const children = subtasksOf(allTodos, todo.id, sort);
  const hasSubtasks = children.length > 0;
  const doneCount = hasSubtasks ? children.filter((c) => c.status === 'done').length : 0;
  const expanded = getExpanded(todo.id);

  // —— Inline "add subtask" UI state ——
  // 提升到 TaskBranch：(a) 叶子任务也要能创建子任务，没有 children ul 可挂；
  // (b) creating 时让 TaskRow 知道当前是"展开状态"，CSS 把 + 按钮常驻。
  // (c) 创建后需要保留 creating=true + 清空 draft 让用户连续创建。
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAddClick = useCallback(() => {
    setCreating(true);
    // 如果父节点已经有 children 但被折叠，先展开让 input 行可见。
    if (hasSubtasks && !expanded) toggleExpanded(todo.id);
  }, [hasSubtasks, expanded, toggleExpanded, todo.id]);

  const handleSubmit = useCallback(async (): Promise<boolean> => {
    const title = draft.trim();
    if (!title) {
      // 空标题：保留 draft，让 SubtaskCreateRow 闪一下 is-error。
      return false;
    }
    if (busy) return false;
    setBusy(true);
    try {
      const ok = await onCreateSubtask(todo.id, title);
      if (ok) {
        setDraft('');
        // creating 保持 true：input 节点不卸载，焦点自然保留，连续创建无感。
      }
      return ok;
    } finally {
      setBusy(false);
    }
  }, [draft, busy, todo.id, onCreateSubtask]);

  const handleCancel = useCallback(() => {
    setCreating(false);
    setDraft('');
  }, []);

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
        creating={creating}
        onAddSubtask={archivedView ? undefined : handleAddClick}
        onDelete={() => onDelete(todo.id)}
        onRestore={() => onRestore(todo.id)}
        todayKey={todayKey}
        onTogglePlan={() => {
          if (todo.plannedFor === todayKey) {
            if (onUnplan) void onUnplan(todo.id);
          } else if (onPlanToday) {
            void onPlanToday(todo.id);
          }
        }}
      />
      {!archivedView && creating && (
        <SubtaskCreateRow
          depth={depth}
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      )}
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
              todayKey={todayKey}
              shownSet={shownSet}
              onCycle={async (next) => {
                await window.todoList.todo.update(c.id, { status: next });
              }}
              onDelete={onDelete}
              onRestore={onRestore}
              onCreateSubtask={onCreateSubtask}
              onPlanToday={onPlanToday}
            />
          ))}
        </ul>
      )}
    </>
  );
};

/** PlannedBranch —— 今日待办上半区的递归组件。
 *
 *  与 TaskBranch 不同：
 *  - children 列表被切两半：shownChildren（已在今日）渲染成正常 TaskBranch，
 *    peerChildren（兄弟里未计划）渲染成 chip。chip 折叠态来自 getPeerExpanded。
 *  - 行尾剔除按钮：仅"本行自身 plannedFor === todayKey"时显示（祖先行不显示，
 *    因为祖先没有 plannedFor —— 它只是因为子被安排了才出现在这里）。
 *  - 不显示"添加子任务"按钮（planning 是上下文行为，不是行内微交互；
 *    用户从下半区添加子任务会更自然）。
 */
const PlannedBranch: React.FC<{
  todo: Todo;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allTodos: Todo[];
  sort: SortKey;
  getExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  todayKey: string;
  shownSet: Set<string>;
  getPeerExpanded: (id: string) => boolean;
  togglePeerExpanded: (id: string) => void;
  onCycle: (next: TodoStatus) => Promise<void>;
  onDelete: (id: string) => void;
  onUnplan: (id: string) => Promise<void>;
  onCreateSubtask: (parentId: string, title: string) => Promise<boolean>;
}> = ({ todo, depth, selectedId, onSelect, allTodos, sort, getExpanded, toggleExpanded, todayKey, shownSet, getPeerExpanded, togglePeerExpanded, onCycle, onDelete, onUnplan, onCreateSubtask }) => {
  const children = subtasksOf(allTodos, todo.id, sort);
  const shownChildren = children.filter((c) => shownSet.has(c.id));
  const peerChildren = children.filter((c) => !shownSet.has(c.id));
  const hasShownChildren = shownChildren.length > 0;
  const hasPeerChildren = peerChildren.length > 0;

  // 展开/折叠：祖先任务强制展开（让今日叶子可见）；叶子任务 hasShownChildren 永远 false。
  // 如果任务只有"自身被安排"且没有 shown children，整个行就是叶子，不需要 children ul。
  const expanded = getExpanded(todo.id);

  // —— Inline "add subtask" UI state ——
  // 上半区与下半区保持一致：叶子任务也能创建子任务；creating=true 时 + 按钮常驻，
  // SubtaskCreateRow 挂在 TaskRow 下方的子任务列表里（深度 +1）。
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAddClick = useCallback(() => {
    setCreating(true);
    if ((hasShownChildren || hasPeerChildren) && !expanded) toggleExpanded(todo.id);
  }, [hasShownChildren, hasPeerChildren, expanded, toggleExpanded, todo.id]);

  const handleSubmit = useCallback(async (): Promise<boolean> => {
    const title = draft.trim();
    if (!title) return false;
    if (busy) return false;
    setBusy(true);
    try {
      const ok = await onCreateSubtask(todo.id, title);
      if (ok) setDraft('');
      return ok;
    } finally {
      setBusy(false);
    }
  }, [draft, busy, todo.id, onCreateSubtask]);

  const handleCancel = useCallback(() => {
    setCreating(false);
    setDraft('');
  }, []);

  // 仅自身今日 = 可剔除；否则仅作为祖先展示。
  return (
    <>
      <TaskRow
        todo={todo}
        depth={depth}
        active={todo.id === selectedId}
        onSelect={onSelect}
        onCycle={onCycle}
        hasSubtasks={hasShownChildren || hasPeerChildren}
        subtaskCount={children.length}
        subtaskDoneCount={children.filter((c) => c.status === 'done').length}
        subtasksExpanded={expanded}
        onToggleSubtasks={() => toggleExpanded(todo.id)}
        archivedView={false}
        creating={creating}
        onAddSubtask={handleAddClick}
        onDelete={() => onDelete(todo.id)}
        onRestore={() => { /* never used in planned section */ }}
        todayKey={todayKey}
        onTogglePlan={() => {
          if (todo.plannedFor === todayKey) {
            void onUnplan(todo.id);
          }
        }}
        hideExpandToggle
      />
      {/* 子任务创建输入行 —— 与下半区一致：creating=true 时挂在该行下方，
          深度 +1。 */}
      {creating && (
        <SubtaskCreateRow
          depth={depth}
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      )}
      {hasShownChildren && (
        <ul className="task-branch__children">
          {shownChildren.map((c) => (
            <PlannedBranch
              key={`shown-${c.id}`}
              todo={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              allTodos={allTodos}
              sort={sort}
              getExpanded={getExpanded}
              toggleExpanded={toggleExpanded}
              todayKey={todayKey}
              shownSet={shownSet}
              getPeerExpanded={getPeerExpanded}
              togglePeerExpanded={togglePeerExpanded}
              onCycle={async (next) => {
                await window.todoList.todo.update(c.id, { status: next });
              }}
              onDelete={onDelete}
              onUnplan={onUnplan}
              onCreateSubtask={onCreateSubtask}
            />
          ))}
        </ul>
      )}
      {/* 兄弟折叠 chip —— 显示在已展示子任务之后，避免与 children ul 抢占缩进。 */}
      {hasPeerChildren && (
        <li
          className="task-row task-row__peer-chip-row"
          style={{ '--row-depth': depth + 1 } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="task-row__peer-chip"
            aria-expanded={getPeerExpanded(todo.id)}
            onClick={() => togglePeerExpanded(todo.id)}
            title={getPeerExpanded(todo.id) ? '收起子任务' : `展开 ${peerChildren.length} 个未计划子任务`}
          >
            <ChevronGlyph open={getPeerExpanded(todo.id)} />
            {getPeerExpanded(todo.id) ? '收起' : `${peerChildren.length} 个子任务`}
          </button>
        </li>
      )}
      {getPeerExpanded(todo.id) && peerChildren.length > 0 && (
        <ul className="task-branch__children task-branch__children--peers">
          {peerChildren.map((c) => (
            <TaskBranch
              key={`peer-${c.id}`}
              todo={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              allTodos={allTodos}
              sort={sort}
              getExpanded={getExpanded}
              toggleExpanded={toggleExpanded}
              archivedView={false}
              todayKey={todayKey}
              shownSet={shownSet}
              onCycle={async (next) => {
                await window.todoList.todo.update(c.id, { status: next });
              }}
              onDelete={onDelete}
              onRestore={() => { /* unused */ }}
              onCreateSubtask={onCreateSubtask}
              onPlanToday={async () => { await window.todoList.todo.update(c.id, { plannedFor: todayKey }); }}
            />
          ))}
        </ul>
      )}
      {/* 上半区不再单独渲染"从今日剔除"按钮 —— 已统一到 TaskRow 行尾的
          + 今日 toggle 按钮（is-active 时实心，aria-label="今天不做了"）。 */}
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
  /** true 表示该行下方的"添加子任务"输入行已经展开，CSS 把 + 按钮常驻可见 */
  creating?: boolean;
  /** 非空时行尾 hover 出现 + 按钮；undefined = 当前行不支持创建（归档视图） */
  onAddSubtask?: () => void;
  /** startOfToday() —— 用于判断本行是否今日；上半区祖先任务行强制显示图标 */
  todayKey: string;
  /** 上半区节点（或下半区祖先已被展示）传 true，行内强制显示今日图标 */
  showPlannedIcon?: boolean;
  /** Toggle plan/unplan for THIS row. Provided in both upper and lower
      sections so the unified button below can flip state either way. */
  onTogglePlan?: () => void;
  /** Hide the SubTask expand/collapse chevron button (and disable the
   *  double-click-to-toggle affordance on the row). The 上半区 "今日待办"
   *  uses this — its descendants are always shown, the chevron would only
   *  be visual noise. The 下半区 keeps the toggle so the user can collapse
   *  a busy branch on demand. */
  hideExpandToggle?: boolean;
}> = ({ todo, depth, active, onSelect, onCycle, hasSubtasks, subtaskCount, subtaskDoneCount, subtasksExpanded, onToggleSubtasks, archivedView, onDelete, onRestore, creating, onAddSubtask, todayKey, onTogglePlan, hideExpandToggle }) => {
  const st = todo.status;
  // Terminal/voided states recede (icon mutes, title strikes); blocked is still
  // active but flagged. Each off-default status gets its own row class so the
  // list reads at a glance: done = cleared, cancelled = voided, blocked = needs attention.
  const recede = st === 'done' || st === 'cancelled';
  const statusCls = st === 'done' ? ' is-done' : st === 'cancelled' ? ' is-cancelled' : st === 'blocked' ? ' is-blocked' : '';
  const creatingCls = creating ? ' is-creating-subtask' : '';
  const isSelfPlanned = todo.plannedFor === todayKey;
  // is-planned class is kept off the row (no longer drives a row tint,
  // see CSS — visual grouping is done by the planned-section / other-
  // section headings). The class still lives here in case future styling
  // wants to hook it.
  const plannedCls = '';
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}${statusCls}${creatingCls}${plannedCls}`}
      style={
        {
          '--row-depth': depth,
          // 0–100; falls back to 0 so the bottom line is invisible for
          // not-started tasks. Drawn as a horizontal fill on the row's
          // bottom edge (see .task-row::after in global.css).
          '--row-progress': `${Math.max(0, Math.min(100, todo.progress ?? 0))}%`,
        } as React.CSSProperties
      }
      onClick={() => onSelect(todo.id)}
      onDoubleClick={(e) => {
        // Double-click toggles expand/collapse WITHOUT deselecting/navigating
        // away — the first click already selected the row. Only meaningful
        // for branching tasks; leaf tasks have nothing to toggle. The 上半区
        // hides the chevron, so this gesture is suppressed there too.
        if (hasSubtasks && !hideExpandToggle) {
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
          {/* 今日状态指示不再在行内以图标方式展示 —— 改为让下方的
              "+ 今日" 按钮同时承担 toggle：实心 = 已加入今日，空心 = 未加入。
              这样上下半区不需要靠一个重复的小绿点区分。 */}
          {/* SubTask collapse/expand chevron — sits right BEFORE the status
              select so it reads "name ▸ status". Only rendered when this
              task actually has subtasks AND the section hasn't asked to
              hide it (上半区 "今日待办" hides it — its descendants are
              always shown, the chevron would be visual noise). */}
          {hasSubtasks && !hideExpandToggle && (
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
          {/* 状态选择器推到行尾，margin-left:auto 让标题左侧不被挤。 */}
          <StatusSelect status={todo.status} onChange={onCycle} variant="icon" />
        </div>
        {/* 第二行：合并旧的 subtitle（优先级/进度/截止/绘图/子任务）+ 行尾
            动作按钮。同一行 flex 布局，左侧元信息（pill 区）、右侧操作。
            pill 区本身可以收缩（min-width:0 + ellipsis），actions 永远
            完整钉在最右。窄行时 pill 区按 fragment 顺序从右向左裁切 —
            优先级、截止日始终排在 fragment 前部，最后才被裁。 */}
        <div className="task-row__meta-line">
          <div className="task-row__meta-pills">
            <Subtitle todo={todo} subtaskCount={subtaskCount} subtaskDoneCount={subtaskDoneCount} />
          </div>
          <div className="task-row__actions">
            {/* 今日 toggle 按钮 —— 上下半区都显示（onTogglePlan 存在时）。
                实心 = 当前已加入今日；空心 = 未加入。
                点击根据当前状态切换：
                  - 未加入 → 加入今日（tooltip 预告下一步 = 切到"今天不做了"）
                  - 已加入 → 从今日剔除（tooltip 预告下一步 = 切到"今天要做的"） */}
            {onTogglePlan && !archivedView && (
              <button
                type="button"
                className={`task-row__action task-row__plan-btn${isSelfPlanned ? ' is-active' : ''}`}
                aria-label={isSelfPlanned ? '今天不做了' : '今天要做的'}
                title={isSelfPlanned ? '今天不做了' : '今天要做的'}
                aria-pressed={isSelfPlanned}
                onClick={(e) => {
                  e.stopPropagation();
                  void onTogglePlan();
                }}
              >
                <TodayGlyph planned={isSelfPlanned} />
              </button>
            )}
            {/* + 子任务：创建时（creating=true）常驻可见作为视觉锚点。archivedView 不显示。 */}
            {onAddSubtask && (
              <button
                type="button"
                className="task-row__action task-row__add-subtask"
                aria-label="添加子任务"
                title="添加子任务"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddSubtask();
                }}
              >
                <PlusGlyph />
              </button>
            )}
            {/* Per-row action — 在 active 列表是 quick delete；归档视图是 restore。 */}
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
        </div>
      </div>
    </li>
  );
};

/** 行内"添加子任务"输入行 — 渲染成 <li> 与 TaskRow 视觉对齐，深度 +1 与未来
 *  子任务同级。draft/busy 由父级 TaskBranch 持有，本组件只渲染 UI + 转抛事件。
 *  - 首次 mount 自动 focus（useEffect）
 *  - Enter 提交；Escape 取消；× 按钮取消
 *  - 提交成功时父级清空 draft，input 节点不卸载 → 焦点自然保留，连续创建无感
 *  - 提交失败时（IPC res.ok=false 或空标题）父级保留 draft；本组件展示 is-error
 *    红色边框 + 抖动一次，让用户感知原因并立即修改重试 */
const SubtaskCreateRow: React.FC<{
  depth: number;
  draft: string;
  busy: boolean;
  onChange: (next: string) => void;
  /** 返回 true = 创建成功；false = 失败（draft 保留，触发 is-error） */
  onSubmit: () => Promise<boolean>;
  onCancel: () => void;
}> = ({ depth, draft, busy, onChange, onSubmit, onCancel }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void onSubmit().then((ok) => {
        if (!ok) {
          setShowError(true);
          // 抖动结束后清除 class，避免下次正常提交时还残留红色
          window.setTimeout(() => setShowError(false), 400);
        }
      });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <li
      className={`task-row task-row__subtask-create${showError ? ' is-error' : ''}`}
      style={{ '--row-depth': depth + 1 } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
          <span className="task-row__icon" aria-hidden="true">
            <PlusGlyph />
          </span>
          <input
            ref={inputRef}
            className="task-row__subtask-input"
            type="text"
            placeholder="添加子任务…（回车创建，Esc 取消）"
            value={draft}
            disabled={busy}
            onChange={(e) => {
              onChange(e.target.value);
              if (showError) setShowError(false);
            }}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className="task-row__action task-row__subtask-cancel"
            aria-label="取消"
            title="取消"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <SubtaskCancelGlyph />
          </button>
        </div>
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
  // 进度以 "X%" pill 紧跟优先级后，按优先级 pill 的色调淡化。Not-started
  // (0%) 不渲染，避免无意义的 "0%" 噪音。
  if (todo.progress != null && todo.progress > 0) {
    bits.push(
      <span key="prog" className="task-row__progress" title={`进度 ${todo.progress}%`}>
        {todo.progress}%
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
  // Subtask progress: "done/total". When all subtasks are done the chip
  // uses the success colour so a glance tells you the branch is clear.
  if (subtaskCount > 0) {
    const allDone = subtaskDoneCount === subtaskCount;
    bits.push(
      <span key="sub" className={allDone ? 'task-row__sub--done' : undefined}>
        {subtaskDoneCount}/{subtaskCount} 子任务
      </span>,
    );
  }
  // 没 metadata 时不渲染任何节点 — 让 meta-line 只显示右边的动作按钮。
  if (bits.length === 0) return null;
  // Subtitle 直接返回 fragment，每个 pill 是 meta-line 的直接子节点：
  //   - flex container 可以正确处理
  //   - container query 选择器直接命中（不需要穿透 wrapper）
  //   - 没有"wrapper 收缩到 0"这个中间层 bug
  return <>{bits}</>;
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

// TodayGlyph — a small circle representing the "planned for today"
// state. When `planned` is true the circle is filled with the accent
// colour (showing this task is on today's list); otherwise it is an
// empty outline (showing the button is the affordance to add it). The
// same glyph is used in the toggle button so visual feedback tracks the
// state on click.
const TodayGlyph: React.FC<{ planned?: boolean }> = ({ planned = false }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.5"
      fill={planned ? 'currentColor' : 'transparent'}
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M6 3.5V6L7.5 7.5" stroke={planned ? 'var(--bg-base)' : 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

// Cancel — × glyph matching the 14×14 stroke family of PlusGlyph / TrashGlyph.
const SubtaskCancelGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
          <span className="task-row__deleted-time">{formatDateTime(todo.deletedAt)}</span>
        </div>
        <div className="task-row__meta-line">
          {descendantCount > 0 && (
            <span className="task-row__sub--done">{descendantCount} 子任务</span>
          )}
          <div className="task-row__actions">
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
              <RestoreGlyph />
            </button>
          </div>
        </div>
      </div>
    </li>
  );
};

function filterToRepoFilter(f: ListFilter): Parameters<typeof window.todoList.todo.list>[0] {
  switch (f.kind) {
    case 'all': return {};
    case 'archived': return { archivedOnly: true };
    case 'deleted': return { deletedOnly: true };
    case 'status': return { status: [f.status as TodoStatus] };
    case 'priority': return { priority: [f.priority as Todo['priority']] };
    default:
      // Exhaustive — future filter kinds should land here.
      return {};
  }
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
