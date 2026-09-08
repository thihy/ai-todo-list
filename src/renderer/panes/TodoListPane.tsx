// Task list — left column of the master-detail layout. 新增任务 input at the
// top; tasks grouped by priority (group headers are gray, small). Each row:
// title + status toggle icon (right) and a metadata subtitle. The bottom-left
// user chip lives in this column's footer.

import React, { useEffect, useState } from 'react';
import { useTodos } from '../hooks/useThihyApi';
import type { ListFilter } from '../router';
import type { Todo, TodoStatus, Priority } from '../../shared/todo-types';
import { UserMenu } from '../components/UserMenu';

const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low', 'none'];
const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
  none: '无优先级',
};

export const TodoListPane: React.FC<{
  filter: ListFilter;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
}> = ({ filter, selectedId, onSelect, onOpenSettings }) => {
  const repoFilter = filterToRepoFilter(filter);
  const { data, loading, refresh } = useTodos(repoFilter);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const onNew = () => document.getElementById('new-todo-input')?.focus();
    document.addEventListener('thihy:new-todo', onNew);
    return () => document.removeEventListener('thihy:new-todo', onNew);
  }, []);

  const submit = async (): Promise<void> => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    await window.thihy.todo.create({ title });
    await refresh();
  };

  const groups = PRIORITY_ORDER.map((p) => ({
    key: p,
    label: PRIORITY_LABEL[p],
    items: data.filter((t) => t.priority === p),
  })).filter((g) => g.items.length > 0);

  const isEmpty = !loading && data.length === 0;

  return (
    <section className="task-list" aria-label="任务列表">
      <header className="task-list__header">
        <input
          id="new-todo-input"
          className="task-list__add"
          placeholder="+ 新增任务（回车保存）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          aria-label="新增任务"
        />
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
              在上方输入一条，或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 快速捕获
            </div>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.key} className="task-group">
            <h2 className="task-group__title">{g.label}</h2>
            <ul className="task-group__items">
              {g.items.map((t) => (
                <TaskRow
                  key={t.id}
                  todo={t}
                  active={t.id === selectedId}
                  onSelect={onSelect}
                  onCycle={async (next) => {
                    await window.thihy.todo.update(t.id, { status: next });
                    await refresh();
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="task-list__footer">
        <UserMenu onOpenSettings={onOpenSettings} />
      </footer>
    </section>
  );
};

const TaskRow: React.FC<{
  todo: Todo;
  active: boolean;
  onSelect: (id: string) => void;
  onCycle: (next: TodoStatus) => Promise<void>;
}> = ({ todo, active, onSelect, onCycle }) => {
  const done = todo.status === 'done';
  return (
    <li
      role="button"
      tabIndex={0}
      className={`task-row${active ? ' is-active' : ''}${done ? ' is-done' : ''}`}
      onClick={() => onSelect(todo.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(todo.id);
      }}
    >
      <div className="task-row__main">
        <div className="task-row__title-line">
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
        </div>
        <Subtitle todo={todo} />
      </div>
    </li>
  );
};

const Subtitle: React.FC<{ todo: Todo }> = ({ todo }) => {
  const bits: React.ReactNode[] = [];
  if (todo.dueAt) bits.push(<span key="d">📅 {formatDate(todo.dueAt)}</span>);
  if (todo.tags?.length) {
    todo.tags.slice(0, 3).forEach((tag) => bits.push(<span key={`t-${tag}`} className="task-row__tag">#{tag}</span>));
  }
  if (todo.drawingIds && todo.drawingIds.length > 0) {
    bits.push(<span key="dr">✏ {todo.drawingIds.length}</span>);
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
  if (idx < 0) return 'inbox'; // blocked or unknown → reset to inbox
  return order[(idx + 1) % order.length];
}

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
    default: // inbox
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--border-strong)" strokeWidth="1.6" />
        </svg>
      );
  }
};

function filterToRepoFilter(f: ListFilter): Parameters<typeof window.thihy.todo.list>[0] {
  switch (f.kind) {
    case 'all': return {};
    case 'today': return { dueBefore: endOfToday(), dueAfter: startOfToday() };
    case 'next7': return { dueBefore: Date.now() + 7 * 24 * 3600_000, dueAfter: startOfToday() };
    case 'inbox': return { status: ['inbox'] };
    case 'project': return { tag: [f.tag] };
    case 'status': return { status: [f.status as TodoStatus] };
    case 'priority': return { priority: [f.priority as Priority] };
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
