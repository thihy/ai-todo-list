// TodoEditorPane — TODO detail surface. Stacked sub-section layout:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ 基本信息                                                   │
//   │   [title (read/dbl-click edit)] [status pill]               │
//   │   [priority] [due] [tags] [created …]                       │
//   │   [progress bar]                                            │
//   │   [drawing strip]                                           │
//   ├─ 链接 ──────────────────────────────────────────────────────┤
//   │   link docs (open / remove) + 添加链接                       │
//   ├─ 文档 ──────────────────────────────────────────────────────┤
//   │   DocumentsView (progress / note_md / drawing / attachment) │
//   ├─ 动态 ──────────────────────────────────────────────────────┤
//   │   progress log timeline + entry                             │
//   └──────────────────────────────────────────────────────────────┘
//
// Summary chrome is "read-first": title shows as a heading (double-click to
// edit, click-to-copy), status is an inline pill right after the name,
// priority is a single flag button + popover, due date is a read chip with
// relative/absolute/overdue phrasing. The pane scrolls as one column of
// titled sections so each facet of the task (identity, links, documents,
// activity) has its own addressable region.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTodo, useDrawings, useDocuments } from '../hooks/useThihyApi';
import { routeToHash } from '../router';
import { DocumentsView } from '../components/DocumentsView';
import { InlineTitle } from '../components/InlineTitle';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { StatusPill } from '../components/StatusPill';
import { ProgressInline, ProgressTimeline } from '../components/ProgressView';
import { DrawingStrip } from '../components/DrawingStrip';
import { IconLink } from '../components/icons';
import type { Priority, TodoStatus, TaskDocument } from '../../shared/todo-types';

/** 链接 section — manages link-kind documents in their own addressable region
 *  (separate from the 文档 workspace, which holds authored content). */
const LinksView: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { documents, refresh } = useDocuments(todoId);
  const links = documents.filter((d) => d.kind === 'link');

  const addLink = useCallback(async () => {
    const url = window.prompt('链接地址', 'https://');
    if (!url) return;
    const title = window.prompt('链接名称（可留空）') || new URL(url).hostname;
    const res = await window.thihy.document.create({ todoId, kind: 'link', title, url });
    if (res.ok) {
      await refresh();
    }
  }, [todoId, refresh]);

  return (
    <div className="links-view">
      {links.length === 0 ? (
        <p className="links-view__empty">暂无链接</p>
      ) : (
        <ul className="links-view__list">
          {links.map((l) => (
            <LinkRow key={l.id} doc={l} onRemoved={refresh} />
          ))}
        </ul>
      )}
      <button type="button" className="links-view__add" onClick={() => void addLink()}>
        + 添加链接
      </button>
    </div>
  );
};

const LinkRow: React.FC<{ doc: TaskDocument; onRemoved: () => Promise<void> }> = ({ doc, onRemoved }) => (
  <li className="links-view__item">
    <IconLink size={14} />
    <a className="links-view__url" href={doc.url ?? '#'} target="_blank" rel="noreferrer">
      {doc.title || doc.url}
    </a>
    <button
      type="button"
      className="links-view__remove"
      title="删除链接"
      onClick={() => {
        if (!window.confirm(`删除「${doc.title ?? doc.url}」？`)) return;
        void window.thihy.document.remove(doc.id).then(onRemoved);
      }}
    >
      ×
    </button>
  </li>
);

export const TodoEditorPane: React.FC<{
  todoId: string;
  navigate: (to: string) => void;
}> = ({ todoId, navigate }) => {
  const { todo, loading } = useTodo(todoId);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);

  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>('none');
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [status, setStatus] = useState<TodoStatus>('next');
  const activityRef = useRef<HTMLElement>(null);

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
    <div className="editor-pane editor-pane--sections">
      {/* ===== 基本信息 ===== */}
      <section className="editor-pane__section">
        <h2 className="editor-pane__section-title">基本信息</h2>
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
          <span className="editor-pane__created" title={new Date(todo.createdAt).toLocaleString()}>
            创建于 {new Date(todo.createdAt).toLocaleDateString()}
          </span>
          <div className="editor-pane__progress">
            <ProgressInline
              todoId={todo.id}
              progress={todo.progress}
              onViewHistory={() =>
                activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            />
          </div>
        </div>

        <DrawingStrip
          drawings={drawings}
          onAdd={() => navigate(routeToHash({ name: 'todo-drawing', id: todo.id }))}
          onOpen={(id) => navigate(routeToHash({ name: 'todo-drawing', id: todo.id, drawingId: id }))}
          onRefresh={refreshDrawings}
        />
      </section>

      {/* ===== 链接 ===== */}
      <section className="editor-pane__section">
        <h2 className="editor-pane__section-title">链接</h2>
        <LinksView todoId={todo.id} />
      </section>

      {/* ===== 文档 ===== */}
      <section className="editor-pane__section">
        <h2 className="editor-pane__section-title">文档</h2>
        <DocumentsView todoId={todo.id} />
      </section>

      {/* ===== 动态 ===== */}
      <section className="editor-pane__section" ref={activityRef}>
        <h2 className="editor-pane__section-title">动态</h2>
        <ProgressTimeline todoId={todo.id} />
      </section>
    </div>
  );
};