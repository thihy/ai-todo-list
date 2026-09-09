// TodoEditorPane — TODO detail surface. Two-band layout:
//
//   ┌──────────────────────────────┬─────────────────────────────┐
//   │ summary band (chrome)        │ body band (workspace)       │
//   │  ─ title (large, editable)   │  ┌─────────────────────┐    │
//   │  ─ meta row                  │  │                     │    │
//   │      [priority] [due]        │  │  markdown editor    │    │
//   │      [status]   [tags]       │  │  (fills space)      │    │
//   │  ─ drawing strip             │  │                     │    │
//   │                              │  └─────────────────────┘    │
//   │                              │  ▾ history drawer (inline)  │
//   └──────────────────────────────┴─────────────────────────────┘
//
// Summary is dense chrome that recedes; body is the work surface.
//
// Why this split:
//   - The summary holds "what is this task?" (identity) — title, status,
//     priority, due date, tags. It should be glanceable, not scrollable.
//   - The body holds "what's happening with this task?" — free-form notes,
//     history. The user scrolls here, the summary stays put via grid
//     placement (top row is `auto`, bottom row is `1fr` + overflow auto).
//   - The drawing strip stays in the summary because drawings ARE part of
//     the task's identity (a sketch attached to a TODO reads as the
//     task, not as a footnote to it).

import React, { useEffect, useState } from 'react';
import { useBody, useHistory, useTodo, useDrawings } from '../hooks/useThihyApi';
import { routeToHash } from '../router';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { DrawingStrip } from '../components/DrawingStrip';
import type { Priority, TodoStatus } from '../../shared/todo-types';

// Status labels centralised so the <select> options and the future
// StatusPicker render the same vocabulary. Single source of truth —
// don't write status display strings in two places.
const STATUS_OPTIONS: { value: TodoStatus; label: string }[] = [
  { value: 'next', label: '未完成' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'blocked', label: '阻塞中' },
];

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
  const [status, setStatus] = useState<TodoStatus>('next');

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
    return <div className="editor-pane__loading">加载中…</div>;
  }

  return (
    <div className="editor-pane">
      {/* ===== Summary band ===== */}
      <header className="editor-pane__summary">
        <input
          className="editor-pane__title"
          aria-label="TODO 标题"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          placeholder="标题"
        />

        <div className="editor-pane__meta">
          <PriorityPicker
            value={priority}
            onChange={(p) => { setPriority(p); void commitMeta({ priority: p }); }}
          />
          <DatePicker
            value={dueAt}
            onChange={(d) => { setDueAt(d); void commitMeta({ dueAt: d }); }}
          />
          <select
            className="editor-pane__status"
            aria-label="状态"
            value={status}
            onChange={(e) => {
              const v = e.target.value as TodoStatus;
              setStatus(v);
              void commitMeta({ status: v });
            }}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <TagInput
            value={tagDraft}
            onChange={(tags) => { setTagDraft(tags); void commitMeta({ tags }); }}
          />
        </div>

        <DrawingStrip
          drawings={drawings}
          onAdd={() => navigate(routeToHash({ name: 'todo-drawing', id: todo.id }))}
          onOpen={(id) => navigate(routeToHash({ name: 'todo-drawing', id: todo.id, drawingId: id }))}
          onRefresh={refreshDrawings}
        />
      </header>

      {/* ===== Body band ===== */}
      <div className="editor-pane__body">
        <MarkdownEditor
          value={body}
          version={version}
          onSave={(md) => save(md, version ?? undefined)}
          saving={saving}
          error={error}
        />

        {versions.length > 0 && (
          <details className="editor-pane__history">
            <summary className="editor-pane__history-head">
              <span>历史版本</span>
              <span className="editor-pane__history-count">{versions.length}</span>
            </summary>
            <ul className="editor-pane__history-list">
              {versions.map((v) => (
                <li key={v.id} className="editor-pane__history-item">
                  <span className="editor-pane__history-time">
                    {new Date(v.savedAt).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="editor-pane__history-restore"
                    onClick={() => window.thihy.content.restoreVersion(todo.id, String(v.id))}
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