// Command palette — Cmd/Ctrl-K. Fuzzy match against routes + todos.

import React, { useEffect, useMemo, useState } from 'react';
import type { Todo } from '../../shared/todo-types';

export const CommandPaletteHost: React.FC<{
  open: boolean;
  onClose: () => void;
  navigate: (to: string) => void;
  onCompose: () => void;
}> = ({ open, onClose, navigate, onCompose }) => {
  const [q, setQ] = useState('');
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    if (!open) return;
    setQ('');
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
    ? todos.filter((t) => fuzzyMatch(t.title, q)).slice(0, 6)
    : todos.slice(0, 4);

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
        <div style={{ marginTop: 'var(--space-md)', maxHeight: 360, overflow: 'auto' }}>
          {filteredCmds.length > 0 && (
            <Section title="命令">
              {filteredCmds.map((c, i) => (
                <Item key={i} onClick={() => { c.run(); onClose(); }}>{c.label}</Item>
              ))}
            </Section>
          )}
          {filteredTodos.length > 0 && (
            <Section title="TODO">
              {filteredTodos.map((t) => (
                <Item key={t.id} onClick={() => { navigate(`#/todo/${t.id}`); onClose(); }}>
                  {t.title || '(无标题)'}
                </Item>
              ))}
            </Section>
          )}
        </div>
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