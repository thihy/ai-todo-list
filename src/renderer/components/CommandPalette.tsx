// Command palette — Cmd/Ctrl-K. Fuzzy match against routes + todos
// with bulk-action support (SEARCH-01): the user can multi-select
// todos in the result list and apply status / priority / plannedFor
// / open / AI-context actions to all of them at once.
//
// AI-context action pushes the selected todo ids into a shared
// "current selection" so the AIPane's composer can offer
// "针对这些任务继续" as the next prompt. This reuses the existing
// `app.focus.set` channel rather than introducing a new IPC.

import React, { useEffect, useMemo, useState } from 'react';
import type { Todo, TodoStatus, Priority, TodoPatch } from '../../shared/todo-types';

type Selection = Set<string>;

export const CommandPaletteHost: React.FC<{
  open: boolean;
  onClose: () => void;
  navigate: (to: string) => void;
  onCompose: () => void;
  /** Optional callback to push a "use these tasks as AI context"
   *  action. The renderer wires this to whatever the AI integration
   *  supports today. When absent the action is hidden. */
  onUseAsAiContext?: (todoIds: string[]) => void;
}> = ({ open, onClose, navigate, onCompose, onUseAsAiContext }) => {
  const [q, setQ] = useState('');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selected, setSelected] = useState<Selection>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Reset transient state every time the palette opens — otherwise
  // stale selections from a previous session leak in.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setSelected(new Set());
    setActionErr(null);
    window.todoList.todo.list({}).then((res) => {
      if (res.ok) setTodos(res.data as Todo[]);
    });
  }, [open]);

  const cmds = useMemo(
    () => [
      { label: '新建 TODO', run: () => onCompose() },
      { label: '未完成', run: () => navigate('#/list/status/next') },
      // 今天 / 未来 7 天 的导航被新的"今日待办 / 其他任务"双区视图替代：
      // 进入默认列表 (kind=all) 即可看到今日 + 全部。
      { label: '全部 TODO', run: () => navigate('#/') },
      { label: '统计', run: () => navigate('#/stats') },
      { label: '设置', run: () => navigate('#/settings') },
      { label: 'AI 助手', run: () => navigate('#/ai') },
    ],
    [navigate, onCompose],
  );

  const filteredCmds = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const filteredTodos = q
    ? todos.filter((t) => fuzzyMatch(t.title, q)).slice(0, 12)
    : todos.slice(0, 6);

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---- batch action handlers -----------------------------------------
  // All actions re-fetch the list after success so the user sees the
  // updated state immediately. Errors surface inline above the action
  // bar; we deliberately don't throw — the palette is supposed to
  // stay open for follow-up actions.
  const applyBatch = async (patch: TodoPatch, label: string): Promise<void> => {
    if (selected.size === 0) return;
    setBusy(true);
    setActionErr(null);
    try {
      const res = await window.todoList.todo.batchUpdate(Array.from(selected), patch);
      if (!res.ok) {
        setActionErr(`${label}失败：${res.message}`);
        return;
      }
      // Refresh local list so the next render reflects the change.
      const fresh = await window.todoList.todo.list({});
      if (fresh.ok) setTodos(fresh.data as Todo[]);
      setSelected(new Set());
    } catch (err) {
      setActionErr(`${label}失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const todayLocal = (): string => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,6,23,0.65)',
        zIndex: 'var(--z-modal)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-md)',
          boxShadow: '0 24px 64px rgba(0,0,0,.5)',
        }}
      >
        <input
          autoFocus
          aria-label="搜索命令"
          placeholder="搜索命令或 TODO…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          style={{ width: '100%' }}
        />
        <div style={{ marginTop: 'var(--space-md)', maxHeight: 320, overflow: 'auto' }}>
          {filteredCmds.length > 0 && (
            <Section title="命令">
              {filteredCmds.map((c, i) => (
                <Item key={i} onClick={() => { c.run(); onClose(); }}>{c.label}</Item>
              ))}
            </Section>
          )}
          {filteredTodos.length > 0 && (
            <Section title="TODO（可多选）">
              {filteredTodos.map((t) => (
                <SelectableItem
                  key={t.id}
                  selected={selected.has(t.id)}
                  onToggle={() => toggleSelected(t.id)}
                  onOpen={() => { navigate(`#/todo/${t.id}`); onClose(); }}
                >
                  {t.title || '(无标题)'}
                </SelectableItem>
              ))}
            </Section>
          )}
        </div>

        {/* Bulk-action bar — SEARCH-01. Only renders when at least one
            todo is selected. We avoid opening a sub-menu by inlining
            all 5 actions as small buttons; the list stays compact. */}
        {selected.size > 0 && (
          <div
            style={{
              marginTop: 'var(--space-md)',
              paddingTop: 'var(--space-sm)',
              borderTop: '1px solid var(--border-default)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <span
              className="muted"
              style={{ fontSize: 'var(--font-xs)', marginRight: 'var(--space-xs)' }}
            >
              {selected.size} 个已选：
            </span>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ status: 'next' as TodoStatus }, '状态 → next')}
            >
              → next
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ status: 'doing' as TodoStatus }, '状态 → doing')}
            >
              → doing
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ status: 'done' as TodoStatus }, '状态 → done')}
            >
              → done
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ priority: 'high' as Priority }, '优先级 → high')}
            >
              优先级 → 高
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ priority: 'low' as Priority }, '优先级 → low')}
            >
              优先级 → 低
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => void applyBatch({ plannedFor: todayLocal() }, '加入今日')}
            >
              加入今日
            </ActionButton>
            {onUseAsAiContext && (
              <ActionButton
                disabled={busy}
                onClick={() => {
                  onUseAsAiContext(Array.from(selected));
                  onClose();
                }}
              >
                作为 AI 上下文
              </ActionButton>
            )}
            <ActionButton
              disabled={busy}
              onClick={() => { navigate(`#/todo/${Array.from(selected)[0]}`); onClose(); }}
            >
              打开
            </ActionButton>
          </div>
        )}

        {actionErr && (
          <div
            className="notice notice--error"
            style={{ marginTop: 'var(--space-sm)' }}
          >
            {actionErr}
          </div>
        )}
      </div>
    </div>
  );
};

function fuzzyMatch(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return i === n.length;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: 'var(--space-md)' }}>
    <div
      style={{
        fontSize: 'var(--font-xs)',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        marginBottom: 'var(--space-xs)',
      }}
    >
      {title}
    </div>
    {children}
  </div>
);

const Item: React.FC<{ children: React.ReactNode; onClick: () => void }> = ({ children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: 'var(--space-sm) var(--space-md)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--fg-primary)',
    }}
    onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-surface-elev)')}
    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
  >
    {children}
  </button>
);

/** Selectable row — checkbox on the left (clicking it toggles selection
 *  without navigating), main body click navigates to the task. The
 *  visual highlight follows `selected`. */
const SelectableItem: React.FC<{
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children: React.ReactNode;
}> = ({ selected, onToggle, onOpen, children }) => (
  <div
    role="row"
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-sm)',
      padding: 'var(--space-xs) var(--space-md)',
      borderRadius: 'var(--radius-md)',
      background: selected ? 'var(--bg-surface-elev)' : 'transparent',
      cursor: 'pointer',
    }}
    onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-surface-elev)')}
    onMouseOut={(e) => (e.currentTarget.style.background = selected ? 'var(--bg-surface-elev)' : 'transparent')}
  >
    <input
      type="checkbox"
      checked={selected}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      aria-label="选择"
      style={{ margin: 0 }}
    />
    <button
      type="button"
      onClick={onOpen}
      style={{
        flex: 1,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        color: 'var(--fg-primary)',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {children}
    </button>
  </div>
);

const ActionButton: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}> = ({ children, onClick, disabled }) => (
  <button
    type="button"
    className="btn-secondary"
    onClick={onClick}
    disabled={disabled}
    style={{ fontSize: 'var(--font-xs)', padding: '4px 8px' }}
  >
    {children}
  </button>
);