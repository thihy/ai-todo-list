// DocumentsView — 任务的多文档工作区（schema v11）。顶部一条横向 tab 栏，
// 选中文档的编辑器填满下方空间：
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [进展] [文档] [绘图]                              [+]      │  ← tab 栏
//   ├──────────────────────────────────────────────────────────────┤
//   │  按 kind 渲染对应编辑器：                                    │
//   │   progress → MarkdownEditor                                │
//   │   note_md   → MarkdownEditor                                │
//   │   drawing   → Excalidraw 编辑器                              │
//   └──────────────────────────────────────────────────────────────┘
//
// 默认 progress 文档（Markdown）ord 为 0，首次打开自动选中。绘图以 tab 形式
// 展示（合并自原来的 新绘图 独立入口）—— 选中绘图 tab 直接挂载 Excalidraw
// 编辑器；+ 菜单里的 绘图 项用于新建。
//
// 注意：链接 和 附件 类文档在此视图里被刻意过滤掉。它们在 TodoEditorPane 里
// 有专属 section（自己的增删 UI），因为它们属于任务身份区的一部分，而不是
// "用户创作内容"，不像 progress / note_md / drawing 那样。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocuments, useDocument, useDrawings } from '../hooks/useTodoListApi';
import { usePrompt } from '../hooks/usePrompt';
import { useFocusSync } from '../hooks/useFocusSync';
import { MarkdownEditor } from './MarkdownEditor';
import { ExcalidrawEditor } from './ExcalidrawEditor';
import {
  IconActivity,
  IconAttach,
  IconClose,
  IconDoc,
  IconDrawing,
  IconFullscreen,
  IconLink,
  IconPlus,
} from './icons';
import type { AppFocus } from '../../shared/todo-list-api';
import type { DocumentKind, TaskDocument } from '../../shared/todo-types';

const KIND_ICON: Record<DocumentKind, React.FC<{ size?: number }>> = {
  progress: IconActivity,
  note_md: IconDoc,
  drawing: IconDrawing,
  // 下面两种 kind 在此视图被过滤掉，占位用避免 Record 出现 undefined 洞
  attachment: IconActivity,
  link: IconActivity,
};

const KIND_LABEL: Record<DocumentKind, string> = {
  progress: '进展',
  note_md: '文档',
  drawing: '绘图',
  // 同上，被过滤；保留以让 Record 完整
  attachment: '附件',
  link: '链接',
};

/** A unified tab entry — either a task_document row or a drawing (drawings
 *  live in their own store but are surfaced as tabs here). */
type Tab =
  | { kind: 'document'; doc: TaskDocument }
  | { kind: 'drawing'; id: string; title: string | null; thumb: string | null };

/** Delete (×) affordance on a tab. The default progress doc is not removable
 *  (it's the task's primary work surface). */
function removeTab(tab: Tab, after: () => void): void {
  if (tab.kind === 'document') {
    const doc = tab.doc;
    if (doc.kind === 'progress') return;
    if (!window.confirm(`删除「${doc.title ?? KIND_LABEL[doc.kind]}」？`)) return;
    if (doc.kind === 'attachment' && doc.refId) {
      void window.todoList.inbox.remove({ id: doc.refId }).then(() => {
        void window.todoList.document.remove(doc.id).then(after);
      });
    } else {
      void window.todoList.document.remove(doc.id).then(after);
    }
    return;
  }
  // drawing
  if (!window.confirm(`删除绘图「${tab.title ?? '无标题'}」？`)) return;
  void window.todoList.drawing.delete(tab.id).then(after);
}

const DocEditor: React.FC<{ doc: TaskDocument }> = ({ doc }) => {
  const { content, version, save, saving, error } = useDocument(doc.id);

  switch (doc.kind) {
    case 'progress':
    case 'note_md':
      return (
        <MarkdownEditor
          docId={doc.id}
          value={content}
          version={version}
          onSave={save}
          saving={saving}
          error={error}
        />
      );
    case 'attachment':
      return <AttachmentView doc={doc} />;
    case 'link':
      return <LinkView doc={doc} />;
    default:
      return <div className="docs-workspace__empty">{KIND_LABEL[doc.kind]} 视图待实现</div>;
  }
};

/** Attachment preview: fetches the bytes as a data URL on demand (images
 *  render inline; other types get a filename + open button). */
const AttachmentView: React.FC<{ doc: TaskDocument }> = ({ doc }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!doc.refId) return;
    setLoading(true);
    window.todoList.inbox
      .read({ id: doc.refId })
      .then((res) => {
        if (res.ok) setDataUrl(res.data.dataUrl);
      })
      .finally(() => setLoading(false));
  }, [doc.refId]);

  const isImage = dataUrl?.startsWith('data:image/') ?? false;

  return (
    <div className="docs-workspace__attachment">
      {loading && <div className="docs-workspace__empty">加载附件…</div>}
      {dataUrl && isImage && <img className="docs-workspace__attachment-img" src={dataUrl} alt={doc.title ?? '附件'} />}
      {dataUrl && !isImage && (
        <div className="docs-workspace__attachment-file">
          <IconAttach /> <span>{doc.title}</span>
        </div>
      )}
      {dataUrl && (
        <a className="docs-workspace__open-link" href={dataUrl} download={doc.title ?? 'attachment'}>
          下载
        </a>
      )}
    </div>
  );
};

const LinkView: React.FC<{ doc: TaskDocument }> = ({ doc }) => (
  <div className="docs-workspace__link">
    <span className="docs-workspace__link-title">
      <IconLink size={14} /> {doc.title}
    </span>
    <a className="docs-workspace__open-link" href={doc.url ?? '#'} target="_blank" rel="noreferrer">
      {doc.url}
    </a>
  </div>
);

/** Drawing tab body: in-place Excalidraw editor. The legacy "open editor"
 *  affordance is gone — selecting a drawing tab mounts the editor here,
 *  mirroring how progress / note_md work in the same workspace. */
const DrawingView: React.FC<{ todoId: string; drawingId: string }> = ({ todoId, drawingId }) => (
  <div className="docs-workspace__drawing">
    <ExcalidrawEditor todoId={todoId} drawingId={drawingId} className="docs-workspace__excalidraw" />
  </div>
);

export const DocumentsView: React.FC<{
  todoId: string;
  /** Task title — included in the focus push so the AI sees it without a
   *  separate todo.get call. Optional; falls back to a generic title. */
  taskTitle?: string | null;
  /** Open the editor fullscreen (hides the task list; AI pane stays). */
  onFullscreen?: () => void;
  /** Controlled active tab id, lifted to the App so the selection survives
   *  the normal ↔ fullscreen unmount/remount of this component. Optional;
   *  when omitted, DocumentsView falls back to its own internal state. */
  selectedDocId?: string | null;
  onSelectDoc?: ((tabId: string) => void) | null;
}> = ({ todoId, taskTitle, onFullscreen, selectedDocId, onSelectDoc }) => {
  const { documents, refresh } = useDocuments(todoId);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);
  const { node: promptNode } = usePrompt();
  // Controlled vs uncontrolled: when the parent passes selectedDocId + a
  // setter, the parent's state is the source of truth (so fullscreen-mode
  // mount can pick up where normal-mode left off). Without those props we
  // fall back to internal state — backwards-compat for any existing caller
  // that doesn't (yet) wire the lift.
  const isControlled = selectedDocId !== undefined && selectedDocId !== null && onSelectDoc != null
    ? true
    : selectedDocId !== undefined && onSelectDoc != null;
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const effectiveSelected = isControlled ? selectedDocId : internalSelected;
  const setSelected = useCallback(
    (id: string): void => {
      if (isControlled && onSelectDoc) {
        onSelectDoc(id);
      } else {
        setInternalSelected(id);
      }
    },
    [isControlled, onSelectDoc],
  );
  const [addOpen, setAddOpen] = useState(false);
  // Inline tab rename (double-click the label). Works for both document tabs
  // (document.rename) and drawing tabs (drawing.rename).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // 拼装统一的 tab 列表：documents 在前（progress 按 ord 排首位），drawings 在后。
  // tab id 加前缀以避免 document id 和 drawing id 冲突。
  //
  // 链接 / 附件 在 TodoEditorPane 里已有专属 section，它们属于任务身份区
  // 而非文档工作区——所以在这里过滤掉（document 行还在磁盘上，只是不再
  // 当成 tab 暴露）。
  const tabs: Tab[] = useMemo(() => {
    const docs: Tab[] = documents
      .filter((d) => d.kind !== 'link' && d.kind !== 'attachment')
      .map((d) => ({ kind: 'document', doc: d }));
    const draws: Tab[] = drawings.map((d) => ({
      kind: 'drawing',
      id: d.id,
      title: d.title,
      thumb: d.thumbPath ?? null,
    }));
    return [...docs, ...draws];
  }, [documents, drawings]);

  const tabId = (t: Tab): string => (t.kind === 'document' ? `d:${t.doc.id}` : `g:${t.id}`);

  // Auto-select the progress doc (first, ord 0) when the list loads or the
  // selection is no longer present (e.g. after a delete). Skip the
  // auto-pick when controlled and the parent hasn't picked yet — the
  // parent may intentionally be holding for a re-render; we don't want to
  // race it and write a default back into its state.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (!effectiveSelected || !tabs.some((t) => tabId(t) === effectiveSelected)) {
      const first = tabs[0]!;
      setSelected(tabId(first));
    }
  }, [tabs, effectiveSelected, setSelected]);

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshDrawings();
  }, [refresh, refreshDrawings]);

  // --- inline tab rename (double-click label → input) ---
  const startEdit = useCallback((tab: Tab): void => {
    const id = tabId(tab);
    const title =
      tab.kind === 'document'
        ? tab.doc.title ?? KIND_LABEL[tab.doc.kind]
        : tab.title ?? '绘图';
    setEditingId(id);
    setEditDraft(title);
  }, []);

  // Focus + select on entry so typing replaces the old label.
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const commitEdit = useCallback(async (): Promise<void> => {
    if (!editingId) return;
    const id = editingId;
    const next = editDraft.trim();
    setEditingId(null);
    if (!next) return;
    const tab = tabs.find((t) => tabId(t) === id);
    if (!tab) return;
    const current =
      tab.kind === 'document'
        ? tab.doc.title ?? KIND_LABEL[tab.doc.kind]
        : tab.title ?? '绘图';
    if (next === current) return;
    if (tab.kind === 'document') {
      const res = await window.todoList.document.rename(tab.doc.id, next);
      if (res.ok) await refresh();
    } else {
      const res = await window.todoList.drawing.rename(tab.id, next);
      if (res.ok) await refreshDrawings();
    }
  }, [editingId, editDraft, tabs, refresh, refreshDrawings]);

  const cancelEdit = useCallback((): void => {
    setEditingId(null);
  }, []);

  const addNote = useCallback(async (): Promise<void> => {
    const res = await window.todoList.document.create({ todoId, kind: 'note_md', title: '文档' });
    if (res.ok) {
      await refresh();
      setSelected(`d:${res.data.id}`);
    }
    setAddOpen(false);
  }, [todoId, refresh]);

  // 绘图: create the drawing in-place, refresh the tab list, and select it.
  // The Excalidraw editor mounts directly inside the tab body — no separate
  // page navigation. (DrawingPane still exists for deep-link back-compat.)
  const addDrawing = useCallback(async (): Promise<void> => {
    const res = await window.todoList.drawing.save(
      todoId,
      { elements: [], appState: {} },
      undefined,
      '新绘图',
    );
    if (res.ok) {
      await refreshDrawings();
      const d = res.data as { id: string };
      setSelected(`g:${d.id}`);
    }
    setAddOpen(false);
  }, [todoId, refreshDrawings, setSelected]);

  // Close the add menu on outside click.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.docs-workspace__add')) setAddOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [addOpen]);

  const selected = tabs.find((t) => tabId(t) === effectiveSelected) ?? null;

  // Push the document/drawing focus to main on every tab change so the AI's
  // `app.currentContext` tool knows what's open. We push the most-specific
  // focus we can; App.tsx pushes a broader task-level focus that gets
  // replaced by this one once the user picks a tab.
  const focus: AppFocus | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'document') {
      const doc = selected.doc;
      return {
        kind: 'document',
        todoId,
        documentId: doc.id,
        documentKind: doc.kind,
        documentTitle: doc.title ?? KIND_LABEL[doc.kind],
        taskTitle: taskTitle ?? null,
      };
    }
    return {
      kind: 'drawing',
      todoId,
      drawingId: selected.id,
      drawingTitle: selected.title,
      taskTitle: taskTitle ?? null,
    };
  }, [selected, todoId, taskTitle]);
  useFocusSync(focus);

  return (
    <div className="docs-workspace docs-workspace--tabs">
      <div className="docs-workspace__tabbar">
        <div className="docs-workspace__tabs" role="tablist">
          {tabs.map((t) => {
            const kind: DocumentKind = t.kind === 'document' ? t.doc.kind : 'drawing';
            const Icon = KIND_ICON[kind]!;
            const id = tabId(t);
            const title = t.kind === 'document' ? t.doc.title ?? KIND_LABEL[t.doc.kind] : t.title ?? '绘图';
            const isEditing = editingId === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === effectiveSelected}
                className={`docs-workspace__tab${id === effectiveSelected ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}`}
                onClick={() => setSelected(id)}
                onDoubleClick={(e) => { e.stopPropagation(); startEdit(t); }}
                title={title}
              >
                <Icon size={14} />
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    className="docs-workspace__tab-input"
                    value={editDraft}
                    aria-label="重命名"
                    onChange={(e) => setEditDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                    }}
                    onBlur={() => { void commitEdit(); }}
                  />
                ) : (
                  <span className="docs-workspace__tab-label">{title}</span>
                )}
                {!isEditing && !(t.kind === 'document' && t.doc.kind === 'progress') && (
                  <span
                    role="button"
                    className="docs-workspace__tab-close"
                    aria-label="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(t, refreshAll);
                    }}
                  >
                    <IconClose size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="docs-workspace__add">
          {onFullscreen && selected && (
            <button
              type="button"
              className="docs-workspace__add-btn"
              onClick={onFullscreen}
              title="全屏编辑 (隐藏任务列表，保留 AI 助手)"
              aria-label="全屏编辑"
            >
              <IconFullscreen size={16} />
            </button>
          )}
          <button
            type="button"
            className="docs-workspace__add-btn"
            onClick={() => setAddOpen((v) => !v)}
            title="新增文档"
            aria-label="新增文档"
          >
            <IconPlus size={16} />
          </button>
          {addOpen && (
            <div className="docs-workspace__add-menu">
              <button type="button" onClick={addNote}>
                <IconDoc size={14} /> Markdown文档
              </button>
              <button type="button" onClick={addDrawing}>
                <IconDrawing size={14} /> 绘图
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="docs-workspace__editor">
        {selected ? (
          selected.kind === 'document' ? (
            <DocEditor key={selected.doc.id} doc={selected.doc} />
          ) : (
            <DrawingView key={selected.id} todoId={todoId} drawingId={selected.id} />
          )
        ) : (
          <div className="docs-workspace__empty">选择上方标签开始编辑</div>
        )}
      </div>
      {promptNode}
    </div>
  );
};
