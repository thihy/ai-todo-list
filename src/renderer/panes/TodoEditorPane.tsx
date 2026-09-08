// TODO editor — title, metadata, markdown body, drawing list, history drawer.

import React, { useEffect, useState } from 'react';
import { useBody, useHistory, useTodo, useDrawings } from '../hooks/useThihyApi';
import { routeToHash } from '../router';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { DrawingStrip } from '../components/DrawingStrip';
import type { Priority, TodoStatus } from '../../shared/todo-types';

export const TodoEditorPane: React.FC<{
  todoId: string;
  navigate: (to: string) => void;
}> = ({ todoId, navigate }) => {
  const { todo, loading } = useTodo(todoId);
  const { body, version, save, saving, error } = useBody(todoId);
  const { versions } = useHistory(todoId);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);

  const [titleDraft, setTitleDraft] = useState('');
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>('none');
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [status, setStatus] = useState<TodoStatus>('inbox');

  useEffect(() => {
    if (!todo) return;
    setTitleDraft(todo.title);
    setTagDraft(todo.tags ?? []);
    setPriority(todo.priority);
    setDueAt(todo.dueAt ?? null);
    setStatus(todo.status);
  }, [todo]);

  const commitTitle = async (): Promise<void> => {
    if (!todo) return;
    if (titleDraft !== todo.title) {
      await window.thihy.todo.update(todo.id, { title: titleDraft });
    }
  };

  const commitMeta = async (
    patch: Parameters<typeof window.thihy.todo.update>[1],
  ): Promise<void> => {
    if (!todo) return;
    await window.thihy.todo.update(todo.id, patch);
  };

  if (loading || !todo) {
    return (
      <div style={{ padding: 'var(--space-lg)', color: 'var(--fg-muted)' }}>加载中…</div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: 'var(--space-md) var(--space-lg)',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--bg-surface)',
        }}
      >
        <input
          aria-label="TODO 标题"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          placeholder="标题"
          style={{
            width: '100%',
            border: 0,
            background: 'transparent',
            fontSize: 'var(--font-2xl)',
            fontWeight: 600,
            padding: 0,
          }}
        />
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-md)',
            alignItems: 'center',
            marginTop: 'var(--space-sm)',
            flexWrap: 'wrap',
          }}
        >
          <PriorityPicker value={priority} onChange={(p) => { setPriority(p); void commitMeta({ priority: p }); }} />
          <DatePicker
            value={dueAt}
            onChange={(d) => { setDueAt(d); void commitMeta({ dueAt: d }); }}
          />
          <select
            aria-label="状态"
            value={status}
            onChange={(e) => {
              const v = e.target.value as TodoStatus;
              setStatus(v);
              void commitMeta({ status: v });
            }}
            style={{ padding: 'var(--space-xs) var(--space-sm)' }}
          >
            <option value="inbox">收件箱</option>
            <option value="next">待办</option>
            <option value="doing">进行中</option>
            <option value="blocked">阻塞</option>
            <option value="done">已完成</option>
          </select>
          <TagInput value={tagDraft} onChange={(tags) => { setTagDraft(tags); void commitMeta({ tags }); }} />
        </div>
        <DrawingStrip
          drawings={drawings}
          onAdd={() => navigate(routeToHash({ name: 'todo-drawing', id: todo.id }))}
          onOpen={(id) => navigate(routeToHash({ name: 'todo-drawing', id: todo.id, drawingId: id }))}
          onRefresh={refreshDrawings}
        />
      </header>

      <div style={{ overflow: 'auto', padding: 'var(--space-lg)' }}>
        <MarkdownEditor
          value={body}
          version={version}
          onSave={(md) => save(md, version ?? undefined)}
          saving={saving}
          error={error}
        />
        {versions.length > 0 && (
          <details style={{ marginTop: 'var(--space-xl)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--fg-secondary)' }}>
              历史版本 ({versions.length})
            </summary>
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-md)' }}>
              {versions.map((v) => (
                <li
                  key={v.id}
                  style={{
                    padding: 'var(--space-sm) 0',
                    borderBottom: '1px solid var(--border-default)',
                  }}
                >
                  <span style={{ color: 'var(--fg-muted)' }}>
                    {new Date(v.savedAt).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    onClick={() => window.thihy.content.restoreVersion(todo.id, String(v.id))}
                    style={{
                      marginLeft: 'var(--space-md)',
                      color: 'var(--accent-primary)',
                    }}
                  >
                    还原
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
};