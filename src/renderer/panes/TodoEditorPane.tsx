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
import { useTodo, useDocuments } from '../hooks/useTodoListApi';
import { usePrompt } from '../hooks/usePrompt';
import { useFocusSync } from '../hooks/useFocusSync';
import { DocumentsView } from '../components/DocumentsView';
import { InlineTitle } from '../components/InlineTitle';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { StatusSelect } from '../components/StatusSelect';
import { ProgressInline, ProgressTimeline } from '../components/ProgressView';
import { IconExternal, IconLink, IconPlus } from '../components/icons';
import type { Priority, TodoStatus, TaskDocument } from '../../shared/todo-types';

/** 链接 section — manages link-kind documents in their own addressable region
 *  (separate from the 文档 workspace, which holds authored content). */
const LinksView: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { documents, refresh } = useDocuments(todoId);
  const { prompt, node: promptNode } = usePrompt();
  const links = documents.filter((d) => d.kind === 'link');

  const addLink = useCallback(async () => {
    const url = await prompt('链接地址', 'https://');
    if (!url) return;
    const title = (await prompt('链接名称（可留空）')) || new URL(url).hostname;
    const res = await window.todoList.document.create({ todoId, kind: 'link', title, url });
    if (res.ok) {
      await refresh();
    }
  }, [todoId, refresh, prompt]);

  return (
    <div className="links-view">
      <ul className="links-view__list">
        {links.map((l) => (
          <LinkRow key={l.id} doc={l} onRemoved={refresh} />
        ))}
      </ul>
      <button type="button" className="links-view__add" onClick={() => void addLink()}>
        <IconPlus size={14} /> 添加链接
      </button>
      {promptNode}
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
        void window.todoList.document.remove(doc.id).then(onRemoved);
      }}
    >
      ×
    </button>
  </li>
);

export const TodoEditorPane: React.FC<{
  todoId: string;
  /** Open the document workspace fullscreen (hides the task list; AI stays). */
  onFullscreen?: () => void;
}> = ({ todoId, onFullscreen }) => {
  const { todo, loading } = useTodo(todoId);

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
    patch: Parameters<typeof window.todoList.todo.update>[1],
  ): Promise<void> => {
    if (!todo) return;
    await window.todoList.todo.update(todo.id, patch);
  };

  // Push a task-level focus pointer. DocumentsView will push a more-specific
  // document/drawing focus as the user picks tabs; this broader pointer is
  // what the AI sees when the user is in the basic-info / links / activity
  // regions (no doc open yet) — giving the AI at minimum the task's id and
  // title so it can ground its answers.
  //
  // MUST be called unconditionally on every render (hooks rules). When the
  // task isn't loaded yet we pass null — main treats that as "nothing
  // focused" and the AI's app.currentContext tool returns null.
  useFocusSync(
    todo
      ? { kind: 'task', todoId: todo.id, taskTitle: todo.title }
      : null,
  );

  if (loading || !todo) {
    return <div className="editor-pane__loading">加载中…</div>;
  }

  return (
    <div className="editor-pane editor-pane--sections">
      {/* ===== 基本信息 (no heading — the title is the hero) ===== */}
      <section className="editor-pane__section editor-pane__section--basic">
        <div className="editor-pane__title-line">
          <StatusSelect
            status={status}
            onChange={(v) => { setStatus(v); void commitMeta({ status: v }); }}
            variant="icon"
          />
          <InlineTitle
            value={todo.title}
            onCommit={(next) => { void commitMeta({ title: next }); }}
          />
          <span
            className="editor-pane__created"
            title={new Date(todo.createdAt).toLocaleString()}
          >
            创建于 {new Date(todo.createdAt).toLocaleDateString()}
          </span>
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

        {/* Progress gets its own row so the bar can span the full width and
            reads as a first-class status of the task, not a tucked-away chip. */}
        <div className="editor-pane__progress-row">
          <ProgressInline todoId={todo.id} progress={todo.progress} />
        </div>
      </section>

      {/* ===== 链接 / 文档 / 动态 — these scroll, the header above does not.
            Keeping the scroll root here (not on the whole pane) means the
            基本信息 popovers are never clipped by an overflow ancestor. ===== */}
      <div className="editor-pane__scroll">
        <section className="editor-pane__section">
          <h2 className="editor-pane__section-title">链接</h2>
          <LinksView todoId={todo.id} />
        </section>

        <section className="editor-pane__section">
          <div className="editor-pane__section-head">
            <h2 className="editor-pane__section-title">文档</h2>
            <button
              type="button"
              className="editor-pane__section-action"
              title="在文件管理器中打开此任务的目录"
              aria-label="打开任务目录"
              onClick={() => { void window.todoList.app.openTaskDir(todo.id); }}
            >
              <IconExternal size={14} />
            </button>
          </div>
          <DocumentsView
            todoId={todo.id}
            taskTitle={todo.title}
            onFullscreen={onFullscreen}
          />
        </section>

        <section className="editor-pane__section" ref={activityRef}>
          <h2 className="editor-pane__section-title">动态</h2>
          <ProgressTimeline todoId={todo.id} />
        </section>
      </div>
    </div>
  );
};