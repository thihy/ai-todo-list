// Task list — left column of the master-detail layout. Renders groups as a
// hand-edited directory TREE (folders) with tasks as leaves (files).
// L5 redesign:
//   - Groups indent by nesting depth (Group > sub-Group > sub-sub-Group).
//   - Tasks inside a group indent ONE more level than the group itself.
//   - SubTasks (parentId !== null) indent UNDER their parent task, recursively.
//   - Root-level tasks (no parentId, no groupId) render INLINE at the top
//     of the tree; there is no "未分组" section header — "no group" is just
//     "depth 0 in the tree".
//   - Double-clicking a group row toggles expand/collapse (NOT rename).
//   - Each group row has its action icons RIGHT-ALIGNED in a fixed slot:
//     ✏ 重命名 · 📁 新建子分组 · 🗑 删除. They fade in on hover but the
//     rename slot is always discoverable, so users don't have to discover
//     the double-click-to-rename gesture (which used to conflict with
//     double-click = expand).

import React, { useEffect, useMemo, useState } from 'react';
import { useTodos, useGroups } from '../hooks/useThihyApi';
import type { ListFilter } from '../router';
import type { Todo, TodoStatus, Group, ULID } from '../../shared/todo-types';
import { UserMenu } from '../components/UserMenu';

interface GroupNode {
  group: Group;
  children: GroupNode[];
  /** Tasks filed directly under this group (does NOT include SubTasks —
   *  SubTasks are rendered under their parent task, not under the group). */
  tasks: Todo[];
}

export const TodoListPane: React.FC<{
  filter: ListFilter;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
}> = ({ filter, selectedId, onSelect, onOpenSettings, onCompose }) => {
  const repoFilter = filterToRepoFilter(filter);
  const { data, loading, refresh } = useTodos(repoFilter);
  const groupsApi = useGroups();

  // Auto-refresh the group tree when a new todo is created elsewhere.
  useEffect(() => {
    const off = window.thihy.on('app:todo-created', () => {
      void refresh();
      void groupsApi.refresh();
    });
    return off;
  }, [refresh, groupsApi]);

  const tree = useMemo(() => buildTree(groupsApi.groups, data), [groupsApi.groups, data]);
  // Root-level tasks: top-level (no parentId) AND unfiled (no groupId).
  // These render inline above the group tree with no section header.
  const rootTasks = useMemo(
    () => data.filter((t) => !t.groupId && !t.parentId),
    [data],
  );
  const isEmpty = !loading && data.length === 0 && groupsApi.groups.length === 0;

  return (
    <section className="task-list" aria-label="任务列表">
      <header className="task-list__header">
        <button type="button" className="task-list__add-btn" onClick={onCompose}>
          <PlusGlyph /> 新建任务
        </button>
        <button
          type="button"
          className="task-list__add-group"
          aria-label="新建分组"
          title="新建分组"
          onClick={() => void groupsApi.create('新建分组')}
        >
          <FolderPlusGlyph />
        </button>
      </header>

      <div className="task-list__body">
        {loading && data.length === 0 && groupsApi.groups.length === 0 && (
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

        {/* Root-level tasks render INLINE here — no "未分组" section header. */}
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

        {tree.map((node) => (
          <GroupBranch
            key={node.group.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
            counts={groupsApi.counts}
            api={groupsApi}
            allTodos={data}
            onCycle={async (t, next) => {
              await window.thihy.todo.update(t.id, { status: next });
              await refresh();
            }}
          />
        ))}
      </div>

      <footer className="task-list__footer">
        <UserMenu onOpenSettings={onOpenSettings} />
      </footer>
    </section>
  );
};

// ----- Group row -----

const GroupBranch: React.FC<{
  node: GroupNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  counts: Record<string, number>;
  api: {
    rename: (id: string, name: string) => Promise<void>;
    create: (name: string, parentId?: string | null) => Promise<void>;
    remove: (id: string) => Promise<void>;
    refresh: () => Promise<void>;
  };
  allTodos: Todo[];
  onCycle: (t: Todo, next: TodoStatus) => Promise<void>;
}> = ({ node, depth, selectedId, onSelect, counts, api, onCycle, allTodos }) => {
  // Default expanded; the user can collapse. We deliberately don't persist
  // expansion across sessions — re-expanding on app launch matches the
  // user's mental model ("I left it the way I see it now").
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.group.name);
  const hasChildren = node.children.length > 0 || node.tasks.length > 0;

  const commitRename = async (): Promise<void> => {
    const name = draft.trim();
    if (!name) {
      setDraft(node.group.name);
      setEditing(false);
      return;
    }
    if (name !== node.group.name) await api.rename(node.group.id, name);
    setEditing(false);
  };

  return (
    <section className="task-group" style={{ '--group-depth': depth } as React.CSSProperties}>
      <div
        className="task-group__head"
        // L5: double-click toggles expand, NOT rename. The rename affordance
        // moved to a dedicated ✏ icon on the right side of the row, so the
        // double-click gesture can safely serve the primary expand/collapse
        // behavior without conflicting with rename.
        onDoubleClick={() => setExpanded((v) => !v)}
      >
        <button
          type="button"
          className="task-group__chevron"
          aria-label={expanded ? '折叠' : '展开'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronGlyph open={expanded} />
        </button>
        <span className="task-group__folder" aria-hidden="true">
          <FolderGlyph />
        </span>
        {editing ? (
          <input
            className="task-group__name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              else if (e.key === 'Escape') {
                setDraft(node.group.name);
                setEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="task-group__name">{node.group.name}</span>
        )}
        <span className="task-group__count">{counts[node.group.id] ?? 0}</span>

        {/* Right-aligned action slot. ✏ is the discoverable rename affordance
            (replaces the old double-click-to-rename gesture); 📁+ creates a
            child group; 🗑 removes the group (tasks become root-level). All
            three sit on the right edge with consistent spacing. */}
        <span className="task-group__actions">
          <button
            type="button"
            className="task-group__action"
            aria-label="重命名分组"
            title="重命名"
            onClick={() => {
              setDraft(node.group.name);
              setEditing(true);
            }}
          >
            <PencilGlyph />
          </button>
          <button
            type="button"
            className="task-group__action"
            aria-label="新建子分组"
            title="新建子分组"
            onClick={() => {
              void api.create('新建分组', node.group.id).then(() => setExpanded(true));
            }}
          >
            <FolderPlusGlyph />
          </button>
          <button
            type="button"
            className="task-group__action task-group__action--danger"
            aria-label="删除分组"
            title="删除分组（子分组一并删除，其中的任务移至根）"
            onClick={() => {
              if (hasChildren) {
                const ok = window.confirm(`删除分组「${node.group.name}」？子分组将一并删除，其中的任务移至根。`);
                if (!ok) return;
              }
              void api.remove(node.group.id);
            }}
          >
            <TrashGlyph />
          </button>
        </span>
      </div>
      {expanded && (
        <>
          {node.children.map((child) => (
            <GroupBranch
              key={child.group.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              counts={counts}
              api={api}
              allTodos={allTodos}
              onCycle={onCycle}
            />
          ))}
          {node.tasks.length > 0 && (
            <ul className="task-group__items">
              {node.tasks.map((t) => (
                <TaskBranch
                  key={t.id}
                  todo={t}
                  depth={depth + 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  allTodos={allTodos}
                  onCycle={async (next) => {
                    await window.thihy.todo.update(t.id, { status: next });
                    await api.refresh();
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
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
          {/* SubTask expand/collapse chevron — only rendered when this task
              actually has subtasks, so leaf tasks don't carry dead chrome.
              Click toggles the subtask list; clicking the row body still
              selects the task. */}
          {hasSubtasks ? (
            <button
              type="button"
              className="task-row__chevron"
              aria-label={subtasksExpanded ? '折叠子任务' : '展开子任务'}
              aria-expanded={subtasksExpanded}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSubtasks();
              }}
            >
              <ChevronGlyph open={subtasksExpanded} />
            </button>
          ) : (
            <span className="task-row__chevron-spacer" aria-hidden="true" />
          )}
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
        <Subtitle todo={todo} hasSubtasks={hasSubtasks} subtaskCount={undefined} />
      </div>
    </li>
  );
};

const Subtitle: React.FC<{ todo: Todo; hasSubtasks: boolean; subtaskCount: number | undefined }> = ({ todo, hasSubtasks }) => {
  const bits: React.ReactNode[] = [];
  if (todo.dueAt) bits.push(<span key="d">📅 {formatDate(todo.dueAt)}</span>);
  if (todo.tags?.length) {
    todo.tags.slice(0, 3).forEach((tag) => bits.push(<span key={`t-${tag}`} className="task-row__tag">#{tag}</span>);
    );
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

function buildTree(groups: Group[], todos: Todo[]): GroupNode[] {
  const byParent = new Map<string | null, Group[]>();
  for (const g of groups) {
    const key = g.parentId;
    const arr = byParent.get(key) ?? [];
    arr.push(g);
    byParent.set(key, arr);
  }
  const tasksByGroup = new Map<string, Todo[]>();
  for (const t of todos) {
    if (!t.groupId) continue;
    // SubTasks follow their parent task, not the group — only top-level
    // tasks (no parentId) belong in the group's task list.
    if (t.parentId) continue;
    const arr = tasksByGroup.get(t.groupId) ?? [];
    arr.push(t);
    tasksByGroup.set(t.groupId, arr);
  }
  const build = (parentId: string | null): GroupNode[] =>
    (byParent.get(parentId) ?? []).map((group) => ({
      group,
      children: build(group.id),
      tasks: tasksByGroup.get(group.id) ?? [],
    }));
  return build(null);
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

const FolderGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M1.5 4.5C1.5 3.67 2.17 3 3 3h3l1.5 1.5H13c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7.5z"
      fill="var(--accent-primary-soft)" stroke="var(--accent-primary)" strokeWidth="1" />
  </svg>
);

const PlusGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const FolderPlusGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M1.5 4.5C1.5 3.67 2.17 3 3 3h3l1.5 1.5H13c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7.5z"
      fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const TrashGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 4h10M6.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

const PencilGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
    <path d="M10 3l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
