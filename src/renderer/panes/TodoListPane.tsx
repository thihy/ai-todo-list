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
import type { ListFilter } from '../router';
import type { Todo, TodoStatus, ULID } from '../../shared/todo-types';
import { UserMenu } from '../components/UserMenu';

export const TodoListPane: React.FC<{
  filter: ListFilter;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
}> = ({ filter, selectedId, onSelect, onOpenSettings, onCompose }) => {
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

  const onDelete = useCallback(async (id: string) => {
    await window.thihy.todo.delete(id);
    await refresh();
  }, [refresh]);

  // Root tasks: top-level (no parentId). SubTasks nest under their parent
  // via TaskBranch, so the root list is just the parentId === null set.
  const rootTasks = useMemo(() => data.filter((t) => !t.parentId), [data]);
  const isEmpty = !loading && data.length === 0;
  return (
    <section className="task-list" aria-label="任务列表">
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
        {loading && data.length === 0 && (
          <div className="task-list__hint">加载中…</div>
        )}
        {isEmpty && (
          <div className="task-list__empty">
            <div className="task-list__empty-glyph" aria-hidden="true">📭</div>
            <div>暂无任务</div>
            <div className="task-list__empty-hint">
              点击上方「新建任务」输入，或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 快速捕获
            </div>
          </div>
        )}

        {rootTasks.length > 0 && (
          <ul className="task-list__root-tasks">
            {rootTasks.map((t) => (
              <TaskBranch
                key={t.id}
                todo={t}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                allTodos={data}
                getExpanded={getExpanded}
                toggleExpanded={toggleExpanded}
                onCycle={async (next) => {
                  await window.thihy.todo.update(t.id, { status: next });
                  await refresh();
                }}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="task-list__footer">
        <UserMenu onOpenSettings={onOpenSettings} />
      </footer>
    </section>
  );
};

// ----- Task row (with SubTask nesting) -----

/** Walk the allTodos list to find direct subtasks of `parent`. SubTasks are
 *  tasks whose parentId points at `parent`. We filter in renderer code (not
 *  repo) so the entire SubTask subtree is computed from the already-fetched
 *  todo list without an extra round-trip per parent. */
function subtasksOf(allTodos: Todo[], parent: ULID): Todo[] {
  return allTodos.filter((t) => t.parentId === parent);
}

const TaskBranch: React.FC<{
  todo: Todo;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  allTodos: Todo[];
  getExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  onCycle: (next: TodoStatus) => Promise<void>;
  onDelete: (id: string) => void;
}> = ({ todo, depth, selectedId, onSelect, allTodos, getExpanded, toggleExpanded, onCycle, onDelete }) => {
  const children = subtasksOf(allTodos, todo.id);
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
        onDelete={() => onDelete(todo.id)}
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
              getExpanded={getExpanded}
              toggleExpanded={toggleExpanded}
              onCycle={async (next) => {
                await window.thihy.todo.update(c.id, { status: next });
              }}
              onDelete={onDelete}
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
  onDelete: () => void;
}> = ({ todo, depth, active, onSelect, onCycle, hasSubtasks, subtaskCount, subtaskDoneCount, subtasksExpanded, onToggleSubtasks, onDelete }) => {
  const done = todo.status === 'done';
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}${done ? ' is-done' : ''}`}
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
            {hasSubtasks ? <TaskBranchGlyph open={subtasksExpanded} done={done} /> : <TaskGlyph done={done} />}
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
          <button
            type="button"
            className="task-row__status"
            aria-label={`状态：${STATUS_LABEL[todo.status] ?? todo.status}，点击切换`}
            title={`状态：${STATUS_LABEL[todo.status] ?? todo.status}（点击切换）`}
            onClick={(e) => {
              e.stopPropagation();
              void onCycle(nextStatus(todo.status));
            }}
          >
            <StatusGlyph status={todo.status} />
          </button>
          {/* Quick delete — hidden until the row is hovered so the chrome
              stays calm at rest. stopPropagation so the row click (select)
              doesn't fire. */}
          <button
            type="button"
            className="task-row__delete"
            aria-label="删除任务"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <TrashGlyph />
          </button>
        </div>
        <Subtitle todo={todo} subtaskCount={subtaskCount} subtaskDoneCount={subtaskDoneCount} />
      </div>
    </li>
  );
};

const Subtitle: React.FC<{ todo: Todo; subtaskCount: number; subtaskDoneCount: number }> = ({ todo, subtaskCount, subtaskDoneCount }) => {
  const bits: React.ReactNode[] = [];
  if (todo.dueAt) bits.push(<span key="d">📅 {formatDate(todo.dueAt)}</span>);
  if (todo.tags?.length) {
    todo.tags.slice(0, 3).forEach((tag) => bits.push(<span key={`t-${tag}`} className="task-row__tag">#{tag}</span>));
  }
  if (todo.drawingIds && todo.drawingIds.length > 0) {
    bits.push(<span key="dr">✏ {todo.drawingIds.length}</span>);
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

const STATUS_LABEL: Record<TodoStatus, string> = {
  inbox: '收件箱',
  next: '待办',
  doing: '进行中',
  blocked: '阻塞',
  done: '已完成',
};

function nextStatus(s: TodoStatus): TodoStatus {
  const order: TodoStatus[] = ['inbox', 'next', 'doing', 'done'];
  const idx = order.indexOf(s);
  if (idx < 0) return 'inbox';
  return order[(idx + 1) % order.length];
}

// ----- Glyphs -----

const StatusGlyph: React.FC<{ status: TodoStatus }> = ({ status }) => {
  switch (status) {
    case 'done':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="8" fill="var(--accent-success)" />
          <path d="M5.5 9.2L8 11.5L12.5 6.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'doing':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--accent-primary)" strokeWidth="1.6" />
          <path d="M9 1.8A7.2 7.2 0 0116.2 9H9z" fill="var(--accent-primary)" />
        </svg>
      );
    case 'next':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--fg-secondary)" strokeWidth="1.6" />
          <circle cx="9" cy="9" r="2.6" fill="var(--accent-primary)" />
        </svg>
      );
    case 'blocked':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--accent-danger)" strokeWidth="1.6" />
          <path d="M4 4L14 14" stroke="var(--accent-danger)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--border-strong)" strokeWidth="1.6" />
        </svg>
      );
  }
};

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

function filterToRepoFilter(f: ListFilter): Parameters<typeof window.thihy.todo.list>[0] {
  switch (f.kind) {
    case 'all': return {};
    case 'today': return { dueBefore: endOfToday(), dueAfter: startOfToday() };
    case 'next7': return { dueBefore: Date.now() + 7 * 24 * 3600_000, dueAfter: startOfToday() };
    case 'inbox': return { status: ['inbox'] };
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
