// TodoEditorPane — TODO detail surface. Two-band layout:
//
//   ┌──────────────────────────────┬─────────────────────────────┐
//   │ summary band (chrome)        │ body band (workspace)       │
//   │  ─ [title (read/dbl-click     │  ┌─────────────────────┐    │
//   │     edit)] [status pill]     │  │                     │    │
//   │  ─ meta row                  │  │  markdown editor    │    │
//   │      [priority] [due] [tags] │  │  (fills space)      │    │
//   │  ─ drawing strip             │  │                     │    │
//   │                              │  └─────────────────────┘    │
//   │                              │  ▾ history drawer (inline)  │
//   └──────────────────────────────┴─────────────────────────────┘
//
// Summary chrome is "read-first": title shows as a heading (double-click to
// edit, click-to-copy), status is an inline pill right after the name,
// priority is a single flag button + popover, due date is a read chip with
// relative/absolute/overdue phrasing. The summary stays glanceable; the body
// is the work surface and scrolls independently (grid top row `auto`, bottom
// `1fr` + overflow auto). The drawing strip stays in the summary because
// drawings ARE part of the task's identity (a sketch attached to a TODO reads
// as the task, not as a footnote to it).

import React, { useEffect, useState } from 'react';
import { useBody, useHistory, useTodo, useDrawings } from '../hooks/useThihyApi';
import { routeToHash } from '../router';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { InlineTitle } from '../components/InlineTitle';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { StatusPill } from '../components/StatusPill';
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

  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>('none');
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [status, setStatus] = useState<TodoStatus>('next');

  useEffect(() => {
    if (!todo) return;
    setTagDraft(todo.tags ?? []);
    setPriority(todo.priority);
    setDueAt(todo.dueAt ?? null);
    setStatus(todo.status);
  }, [todo]);

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
        <div className="editor-pane__title-line">
          <InlineTitle
            value={todo.title}
            onCommit={(next) => { void commitMeta({ title: next }); }}
          />
          <StatusPill
            status={status}
            onCycle={(v) => { setStatus(v); void commitMeta({ status: v }); }}
          />
        </div>

        <div className="editor-pane__meta">
          <PriorityPicker
            value={priority}
            onChange={(p) => { setPriority(p); void commitMeta({ priority: p }); }}
          />
          <DatePicker
            value={dueAt}
            onChange={(d) => { setDueAt(d); void commitMeta({ dueAt: d }); }}
          />
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