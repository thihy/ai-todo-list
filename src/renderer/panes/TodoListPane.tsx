// Task list — left column of the master-detail layout. Renders a pure
// Task tree: every entry is a Task; a Task may have SubTasks (nested via
// parentId). Root tasks (parentId === null) sit at the top; their subtasks
// nest underneath, recursively. There is no longer a separate "Group"
// concept — everything is a Task.
//
// Tree behaviour:
//   - Indentation by nesting depth, driven by the `--row-depth` CSS custom
//     property so SubTasks visibly nest under their parent.
//   - A Task with SubTasks shows a collapse/expand chevron AFTER its status
//     glyph; clicking it toggles the subtask list (stopPropagation so the
//     row-body click = select still works).
//   - Task rows show a 14×14 document glyph; done tasks get a muted glyph.

import React, { useEffect, useMemo, useState } from 'react';
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
                onCycle={async (next) => {
                  await window.thihy.todo.update(t.id, { status: next });
                  await refresh();
                }}
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
  onCycle: (next: TodoStatus) => Promise<void>;
}> = ({ todo, depth, selectedId, onSelect, allTodos, onCycle }) => {
  const children = subtasksOf(allTodos, todo.id);
  const hasSubtasks = children.length > 0;
  const [expanded, setExpanded] = useState(true);

  return (
    <>
      <TaskRow
        todo={todo}
        depth={depth}
        active={todo.id === selectedId}
        onSelect={onSelect}
        onCycle={onCycle}
        hasSubtasks={hasSubtasks}
        subtasksExpanded={expanded}
        onToggleSubtasks={() => setExpanded((v) => !v)}
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
              onCycle={async (next) => {
                await window.thihy.todo.update(c.id, { status: next });
              }}
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
  subtasksExpanded: boolean;
  onToggleSubtasks: () => void;
}> = ({ todo, depth, active, onSelect, onCycle, hasSubtasks, subtasksExpanded, onToggleSubtasks }) => {
  const done = todo.status === 'done';
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}${done ? ' is-done' : ''}`}
      style={{ '--row-depth': depth } as React.CSSProperties}
      onClick={() => onSelect(todo.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(todo.id);
      }}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
          {/* Document glyph — 14×14. Done tasks get a muted glyph; active
              tasks get the accent color. */}
          <span className="task-row__icon" aria-hidden="true">
            <TaskGlyph done={done} />
          </span>
          <span className="task-row__title">{todo.title || '(无标题)'}</span>
          <button
            type="button"
            className="task-row__status"
            aria-label={`状态：${STATUS_LABEL[todo.status] ?? todo.status}，点击切换`}
            onClick={(e) => {
              e.stopPropagation();
              void onCycle(nextStatus(todo.status));
            }}
          >
            <StatusGlyph status={todo.status} />
          </button>
          {/* SubTask collapse/expand chevron — sits AFTER the status glyph.
              Only rendered when this task actually has subtasks, so leaf
              tasks don't carry dead chrome. Click toggles the subtask list;
              stopPropagation so the row-body click (select) doesn't fire. */}
          {hasSubtasks && (
            <button
              type="button"
              className="task-row__toggle"
              aria-label={subtasksExpanded ? '折叠子任务' : '展开子任务'}
              aria-expanded={subtasksExpanded}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSubtasks();
              }}
            >
              <ChevronGlyph open={subtasksExpanded} />
            </button>
          )}
        </div>
        <Subtitle todo={todo} hasSubtasks={hasSubtasks} subtaskCount={undefined} />
      </div>
    </li>
  );
};

const Subtitle: React.FC<{ todo: Todo; hasSubtasks: boolean; subtaskCount: number | undefined }> = ({ todo, hasSubtasks }) => {
  const bits: React.ReactNode[] = [];
  if (todo.dueAt) bits.push(<span key="d">📅 {formatDate(todo.dueAt)}</span>);
  if (todo.tags?.length) {
    todo.tags.slice(0, 3).forEach((tag) => bits.push(<span key={`t-${tag}`} className="task-row__tag">#{tag}</span>));
  }
  if (todo.drawingIds && todo.drawingIds.length > 0) {
    bits.push(<span key="dr">✏ {todo.drawingIds.length}</span>);
  }
  if (hasSubtasks) bits.push(<span key="sub">▸ 含子任务</span>);
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

const PlusGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
