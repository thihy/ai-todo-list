// TodoEditorPane — TODO detail surface. Stacked sub-section layout:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ 基本信息                                                   │
//   │   [title (read/dbl-click edit)] [status pill]               │
//   │   [priority] [due] [tags] [created …]                       │
//   │   [progress bar]                                            │
//   │   [drawing strip]                                           │
//   ├─ 子任务 ─────────────────────────────────────────────────────┤
//   │   subtask list + inline create row (todo.create({parentId}))│
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTodo, useTodos, useDocuments, useAttachments } from '../hooks/useTodoListApi';
import { useFocusSync } from '../hooks/useFocusSync';
import { DocumentsView } from '../components/DocumentsView';
import { InlineTitle } from '../components/InlineTitle';
import { PriorityPicker } from '../components/PriorityPicker';
import { TagInput } from '../components/TagInput';
import { DatePicker } from '../components/DatePicker';
import { StatusSelect } from '../components/StatusSelect';
import { ProgressInline, ProgressTimeline } from '../components/ProgressView';
import { StatusGlyph, STATUS_LABEL } from '../components/StatusGlyph';
import { IconAttach, IconExternal, IconLink, IconPlus, IconTrash } from '../components/icons';
import type { InboxAttachment, Priority, TodoStatus, TaskDocument } from '../../shared/todo-types';

/** 链接 section — manages link-kind documents in their own addressable region
 *  (separate from the 文档 workspace, which holds authored content). */
const LinksView: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { documents, refresh } = useDocuments(todoId);
  const [adding, setAdding] = useState(false);
  const links = documents.filter((d) => d.kind === 'link');

  const save = useCallback(
    async (vals: { url: string; title: string; description: string }): Promise<void> => {
      // Fall back to the hostname when no title was given/fetched so the row
      // always has something readable.
      let title = vals.title;
      if (!title) {
        try {
          title = new URL(vals.url).hostname;
        } catch {
          title = vals.url;
        }
      }
      const res = await window.todoList.document.create({
        todoId,
        kind: 'link',
        title,
        url: vals.url,
        description: vals.description || null,
      });
      if (res.ok) await refresh();
      setAdding(false);
    },
    [todoId, refresh],
  );

  return (
    <div className="links-view">
      <ul className="links-view__list">
        {links.map((l) => (
          <LinkRow key={l.id} doc={l} onRemoved={refresh} />
        ))}
      </ul>
      <button
        type="button"
        className="links-view__add"
        onClick={() => setAdding(true)}
        title="添加链接"
        aria-label="添加链接"
      >
        <IconPlus size={14} />
      </button>
      {adding && <AddLinkDialog onCancel={() => setAdding(false)} onSave={save} />}
    </div>
  );
};

/** 添加链接 dialog — a single URL + title + description form. When the URL
 *  field loses focus (or Enter is pressed in it), the main process fetches the
 *  page's <title> + meta description and prefills the two lower fields WITHOUT
 *  clobbering anything the user already typed. Save creates a link doc with
 *  all three; Cancel / overlay-click / Esc aborts. Replaces the old two-step
 *  usePrompt flow, which couldn't capture a description and made the user
 *  answer two separate dialogs. */
const AddLinkDialog: React.FC<{
  onCancel: () => void;
  onSave: (vals: { url: string; title: string; description: string }) => Promise<void>;
}> = ({ onCancel, onSave }) => {
  const [url, setUrl] = useState('https://');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus();
    urlRef.current?.select();
  }, []);

  // Fetch page metadata when the user finishes editing the URL. Only fills
  // title/description when still empty so we never overwrite user edits. Any
  // failure is silent — fields stay blank + editable (best-effort, never
  // blocks the save flow).
  const tryFetchMeta = useCallback(async (): Promise<void> => {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    setFetching(true);
    try {
      const res = await window.todoList.link.fetchMeta(trimmed);
      if (!res.ok) return;
      const { title: t, description: d, resolvedUrl } = res.data;
      if (!title && t) setTitle(t);
      if (!description && d) setDescription(d);
      // Follow redirects in the saved URL too (shortlink → canonical).
      if (resolvedUrl && resolvedUrl !== trimmed) setUrl(resolvedUrl);
    } catch {
      /* swallow — best-effort */
    } finally {
      setFetching(false);
    }
  }, [url, title, description]);

  const canSave = url.trim().length > 0 && !saving;
  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({ url: url.trim(), title: title.trim(), description: description.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prompt-overlay" role="dialog" aria-modal="true" onMouseDown={() => onCancel()}>
      <div className="prompt-dialog link-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <label className="prompt-dialog__label" htmlFor="link-url">链接地址</label>
        <input
          id="link-url"
          ref={urlRef}
          type="url"
          className="prompt-dialog__input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => { void tryFetchMeta(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void tryFetchMeta(); }
            else if (e.key === 'Escape') onCancel();
          }}
          placeholder="https://"
        />
        <label className="prompt-dialog__label" htmlFor="link-title">
          标题{fetching ? '（抓取中…）' : ''}
        </label>
        <input
          id="link-title"
          type="text"
          className="prompt-dialog__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
          placeholder={fetching ? '正在获取页面标题…' : '留空则用网址'}
        />
        <label className="prompt-dialog__label" htmlFor="link-desc">简介</label>
        <textarea
          id="link-desc"
          className="prompt-dialog__input link-dialog__desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
          rows={2}
          placeholder="页面简介（可留空）"
        />
        <div className="prompt-dialog__actions">
          <button
            type="button"
            className="prompt-dialog__btn prompt-dialog__btn--ghost"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="prompt-dialog__btn prompt-dialog__btn--primary"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

const LinkRow: React.FC<{ doc: TaskDocument; onRemoved: () => Promise<void> }> = ({ doc, onRemoved }) => (
  <li
    className="links-view__item"
    title={doc.title && doc.url ? `${doc.title}\n${doc.url}` : (doc.title ?? doc.url ?? '')}
  >
    <div className="links-view__main">
      <IconLink size={14} />
      <a className="links-view__url" href={doc.url ?? '#'} target="_blank" rel="noreferrer" title={doc.url ?? ''}>
        {doc.title || doc.url}
      </a>
      <button
        type="button"
        className="links-view__remove"
        title="删除链接"
        onClick={() => {
          if (!window.confirm(`删除链接「${doc.title ?? doc.url}」？`)) return;
          void window.todoList.document.remove(doc.id).then(onRemoved);
        }}
      >
        ×
      </button>
    </div>
    {doc.description && <p className="links-view__desc">{doc.description}</p>}
  </li>
);

/** 附件 section — 与 链接 一致：任务附件文件的扁平列表。
 *  数据来自 `inbox.*`（二进制存在 SQLite inbox_attachments 表），同时每个附件
 *  也作为 kind='attachment' 的 task_document 暴露给 AI（DocumentsView 已过滤）。 */
const AttachmentsView: React.FC<{ todoId: string }> = ({ todoId }) => {
  const { attachments, refresh } = useAttachments(todoId);
  const { documents, refresh: refreshDocs } = useDocuments(todoId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 通过 refId 把每个附件 blob 与对应的 document 行关联（用来取展示标题
  // 和定位要删除的 document）。两边共用 refId 这把钥匙。
  const docByRef = useMemo(() => {
    const m = new Map<string, TaskDocument>();
    for (const d of documents) {
      if (d.kind === 'attachment' && d.refId) m.set(d.refId, d);
    }
    return m;
  }, [documents]);

  const pickFiles = useCallback(async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const attRes = await window.todoList.inbox.attachBlob({
        todoId,
        dataUrl,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
      });
      if (attRes.ok) {
        // 同时创建 companion document 行，AI 才能按 id 引用附件，文件名也能带过去
        await window.todoList.document.create({
          todoId,
          kind: 'attachment',
          title: file.name,
          refId: attRes.data.id,
        });
      }
    }
    await refresh();
    await refreshDocs();
  }, [todoId, refresh, refreshDocs]);

  const removeAttachment = useCallback(async (att: InboxAttachment): Promise<void> => {
    // 用原始文件名（document.title）做提示，磁盘路径带 UUID 后缀不便读
    const doc = docByRef.get(att.id);
    const display = doc?.title ?? att.filePath.split(/[\\/]/).pop() ?? '附件';
    if (!window.confirm(`删除附件「${display}」？`)) return;
    // 先删 companion document（如果有），再删 blob 本身
    if (doc) {
      await window.todoList.document.remove(doc.id);
    }
    await window.todoList.inbox.remove({ id: att.id });
    await refresh();
    await refreshDocs();
  }, [docByRef, refresh, refreshDocs]);

  return (
    <div className="attachments-view">
      <ul className="attachments-view__list">
        {attachments.map((a) => {
          const doc = docByRef.get(a.id);
          const title = doc?.title ?? a.filePath.split(/[\\/]/).pop() ?? '附件';
          const isImage = a.mime.startsWith('image/');
          // title 属性挂详细数据：原始路径 + mime（hover 才展开，不挤占 UI）
          const detail = `${a.filePath}\n${a.mime}`;
          return (
            <li key={a.id} className="attachments-view__item" title={detail}>
              <IconAttach size={14} />
              <a
                className="attachments-view__name"
                href={`attachment://${a.id}`}
                title={title}
              >
                {title}
              </a>
              <a
                className="attachments-view__open"
                href={`attachment://${a.id}`}
                title={isImage ? '预览' : '下载'}
                aria-label={isImage ? '预览' : '下载'}
              >
                {isImage ? '预览' : '下载'}
              </a>
              <button
                type="button"
                className="attachments-view__remove"
                title="删除附件"
                aria-label="删除附件"
                onClick={() => { void removeAttachment(a); }}
              >
                <IconTrash size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="attachments-view__add"
        title="添加附件"
        aria-label="添加附件"
        onClick={() => fileInputRef.current?.click()}
      >
        <IconPlus size={14} />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { void pickFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
};

/** Fired on `window` when a subtask is created from the detail's 子任务
 *  section. The task list (TodoListPane) listens so it can expand the parent
 *  row in the tree — otherwise a parent the user had collapsed would swallow
 *  the freshly-created child. Detail: { id: parentId }. */
export const SUBTASK_CREATED_EVENT = 'todo-list:expand-parent';

/** 子任务 section — lists a task's direct children with an inline create row.
 *  Creating here calls `todo.create({ parentId })` directly (NOT the AI path
 *  the top-level 新建任务 composer uses), so the subtask lands immediately
 *  with a known parent. Mirrors the LinksView / AttachmentsView section
 *  pattern: a list of clickable rows + an inline create affordance. */
const SubtasksView: React.FC<{
  todoId: string;
  navigate: (to: string) => void;
}> = ({ todoId, navigate }) => {
  // parentId filter restricts to direct children only; archived/deleted are
  // excluded by the repo's default scoping, matching what the list tree shows.
  const { data: children, refresh } = useTodos({ parentId: todoId });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const create = useCallback(async (): Promise<void> => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const res = await window.todoList.todo.create({ parentId: todoId, title });
      if (!res.ok) return;
      setDraft('');
      // Tell the list tree to expand this parent so the new child is visible
      // there too (covers the collapsed-parent edge case).
      window.dispatchEvent(new CustomEvent(SUBTASK_CREATED_EVENT, { detail: { id: todoId } }));
      await refresh();
      // Land on the fresh subtask so the user can flesh out its details
      // (status / priority / docs) right away.
      navigate(`#/todo/${res.data.id}`);
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }, [draft, busy, todoId, refresh, navigate]);

  return (
    <div className="subtasks-view">
      <ul className="subtasks-view__list">
        {children.map((c) => (
          <li key={c.id} className="subtasks-view__item">
            <StatusGlyph status={c.status} />
            <button
              type="button"
              className="subtasks-view__title"
              title={`${STATUS_LABEL[c.status]} · 打开子任务`}
              onClick={() => navigate(`#/todo/${c.id}`)}
            >
              {c.title || '(无标题)'}
            </button>
          </li>
        ))}
      </ul>
      <div className="subtasks-view__create">
        <input
          ref={inputRef}
          className="subtasks-view__input"
          type="text"
          placeholder="添加子任务…（回车创建）"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create();
            }
          }}
        />
      </div>
      {children.length === 0 && !draft && (
        <p className="subtasks-view__empty">暂无子任务，在上方输入标题后回车创建。</p>
      )}
    </div>
  );
};

export const TodoEditorPane: React.FC<{
  todoId: string;
  /** 打开文档工作区全屏（隐藏任务列表，AI 面板保留） */
  onFullscreen?: () => void;
  /** 当前活动文档 tab id —— 上提到 App，避免 normal ↔ fullscreen 模式下
   *  DocumentsView 卸载/重挂载后丢失选中（不传则 DocumentsView 回退到自有状态） */
  selectedDocId?: string | null;
  onSelectDoc?: (tabId: string) => void;
  /** Navigate to a route hash — used by the 子任务 section to open a subtask
   *  in the detail pane after creating it. Optional; defaults to no-op. */
  navigate?: (to: string) => void;
}> = ({ todoId, onFullscreen, selectedDocId, onSelectDoc, navigate }) => {
  const navigateFn = navigate ?? (() => {});
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
          <h2 className="editor-pane__section-title">子任务</h2>
          <SubtasksView todoId={todo.id} navigate={navigateFn} />
        </section>

        <section className="editor-pane__section">
          <h2 className="editor-pane__section-title">链接</h2>
          <LinksView todoId={todo.id} />
        </section>

        <section className="editor-pane__section">
          <h2 className="editor-pane__section-title">附件</h2>
          <AttachmentsView todoId={todo.id} />
        </section>

        <section className="editor-pane__section">
          <div className="editor-pane__section-head">
            <h2 className="editor-pane__section-title">文档</h2>
            <button
              type="button"
              className="editor-pane__section-action"
              title="在文件管理器中显示此任务的 Markdown 文件"
              aria-label="在文件管理器中显示任务文件"
              onClick={() => {
                void window.todoList.app.openTaskDir(todo.id).then((res) => {
                  if (!res.ok) {
                    // eslint-disable-next-line no-alert
                    alert(`打开目录失败：${res.message ?? res.code ?? '未知错误'}`);
                  }
                });
              }}
            >
              <IconExternal size={14} />
            </button>
          </div>
          <DocumentsView
            todoId={todo.id}
            taskTitle={todo.title}
            onFullscreen={onFullscreen}
            selectedDocId={selectedDocId ?? null}
            onSelectDoc={onSelectDoc ?? null}
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