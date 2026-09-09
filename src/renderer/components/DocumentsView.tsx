// DocumentsView — the task's multi-document workspace (schema v11). A single
// horizontal tab bar at the top of the editor area, with the active document's
// editor filling the space below:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [📝进展] [📄笔记] [🎨绘图] [📎附件] [🔗链接]        [+]      │  ← tab bar
//   ├──────────────────────────────────────────────────────────────┤
//   │  (per-kind editor fills the space)                          │
//   │   progress → WysiwygEditor                                  │
//   │   note_md   → MarkdownEditor                                │
//   │   drawing   → thumbnail + open Excalidraw                   │
//   │   attachment→ preview/open/remove                           │
//   │   link      → open url                                      │
//   └──────────────────────────────────────────────────────────────┘
//
// The default progress doc (WYSIWYG) is ord 0 and auto-selected on first
// open. Drawings are surfaced here as tabs (merged out of the old
// standalone 新绘图 strip) — selecting a drawing tab shows a thumbnail and an
// "open editor" affordance; the + menu's 绘图 entry creates a new drawing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocuments, useDocument, useDrawings } from '../hooks/useThihyApi';
import { usePrompt } from '../hooks/usePrompt';
import { useFocusSync } from '../hooks/useFocusSync';
import { WysiwygEditor } from './WysiwygEditor';
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
import type { AppFocus } from '../../shared/thihy-api';
import type { DocumentKind, TaskDocument } from '../../shared/todo-types';

const KIND_ICON: Record<DocumentKind, React.FC<{ size?: number }>> = {
  progress: IconActivity,
  note_md: IconDoc,
  drawing: IconDrawing,
  attachment: IconAttach,
  link: IconLink,
};

const KIND_LABEL: Record<DocumentKind, string> = {
  progress: '进展',
  note_md: '笔记',
  drawing: '绘图',
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
      void window.thihy.inbox.remove({ id: doc.refId }).then(() => {
        void window.thihy.document.remove(doc.id).then(after);
      });
    } else {
      void window.thihy.document.remove(doc.id).then(after);
    }
    return;
  }
  // drawing
  if (!window.confirm(`删除绘图「${tab.title ?? '无标题'}」？`)) return;
  void window.thihy.drawing.delete(tab.id).then(after);
}

const DocEditor: React.FC<{ doc: TaskDocument; todoId: string }> = ({ doc, todoId }) => {
  const { content, version, save, saving, error } = useDocument(doc.id);

  switch (doc.kind) {
    case 'progress':
      return (
        <WysiwygEditor
          todoId={todoId}
          value={content}
          version={version}
          onSave={save}
          saving={saving}
          error={error}
        />
      );
    case 'note_md':
      return (
        <MarkdownEditor
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
    window.thihy.inbox
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
}> = ({ todoId, taskTitle, onFullscreen }) => {
  const { documents, refresh } = useDocuments(todoId);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);
  const { prompt, node: promptNode } = usePrompt();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Inline tab rename (double-click the label). Works for both document tabs
  // (document.rename) and drawing tabs (drawing.rename).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Build a unified tab list: documents first (progress pinned first by ord),
  // then drawings. Each tab id is namespaced to avoid collisions between
  // document ids and drawing ids.
  const tabs: Tab[] = useMemo(() => {
    const docs: Tab[] = documents.map((d) => ({ kind: 'document', doc: d }));
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
  // selection is no longer present (e.g. after a delete).
  useEffect(() => {
    if (tabs.length === 0) return;
    if (!selectedId || !tabs.some((t) => tabId(t) === selectedId)) {
      const first = tabs[0]!;
      setSelectedId(tabId(first));
    }
  }, [tabs, selectedId]);

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
      const res = await window.thihy.document.rename(tab.doc.id, next);
      if (res.ok) await refresh();
    } else {
      const res = await window.thihy.drawing.rename(tab.id, next);
      if (res.ok) await refreshDrawings();
    }
  }, [editingId, editDraft, tabs, refresh, refreshDrawings]);

  const cancelEdit = useCallback((): void => {
    setEditingId(null);
  }, []);

  const addNote = useCallback(async (): Promise<void> => {
    const res = await window.thihy.document.create({ todoId, kind: 'note_md', title: '笔记' });
    if (res.ok) {
      await refresh();
      setSelectedId(`d:${res.data.id}`);
    }
    setAddOpen(false);
  }, [todoId, refresh]);

  const addLink = useCallback(async (): Promise<void> => {
    const url = await prompt('链接地址', 'https://');
    if (!url) {
      setAddOpen(false);
      return;
    }
    const title = (await prompt('链接名称（可留空）')) || new URL(url).hostname;
    const res = await window.thihy.document.create({ todoId, kind: 'link', title, url });
    if (res.ok) {
      await refresh();
      setSelectedId(`d:${res.data.id}`);
    }
    setAddOpen(false);
  }, [todoId, refresh, prompt]);

  const addAttachment = useCallback(async (): Promise<void> => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        setAddOpen(false);
        return;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const attRes = await window.thihy.inbox.attachBlob({
        todoId,
        dataUrl,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
      });
      if (attRes.ok) {
        const docRes = await window.thihy.document.create({
          todoId,
          kind: 'attachment',
          title: file.name,
          refId: attRes.data.id,
        });
        if (docRes.ok) {
          await refresh();
          setSelectedId(`d:${docRes.data.id}`);
        }
      }
      setAddOpen(false);
    };
    input.click();
  }, [todoId, refresh]);

  // 绘图: create the drawing in-place, refresh the tab list, and select it.
  // The Excalidraw editor mounts directly inside the tab body — no separate
  // page navigation. (DrawingPane still exists for deep-link back-compat.)
  const addDrawing = useCallback(async (): Promise<void> => {
    const res = await window.thihy.drawing.save(
      todoId,
      { elements: [], appState: {} },
      undefined,
      '新绘图',
    );
    if (res.ok) {
      await refreshDrawings();
      const d = res.data as { id: string };
      setSelectedId(`g:${d.id}`);
    }
    setAddOpen(false);
  }, [todoId, refreshDrawings]);

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

  const selected = tabs.find((t) => tabId(t) === selectedId) ?? null;

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
                aria-selected={id === selectedId}
                className={`docs-workspace__tab${id === selectedId ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}`}
                onClick={() => setSelectedId(id)}
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
                <IconDoc size={14} /> 笔记 (Markdown)
              </button>
              <button type="button" onClick={addDrawing}>
                <IconDrawing size={14} /> 绘图
              </button>
              <button type="button" onClick={addAttachment}>
                <IconAttach size={14} /> 附件
              </button>
              <button type="button" onClick={addLink}>
                <IconLink size={14} /> 链接
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="docs-workspace__editor">
        {selected ? (
          selected.kind === 'document' ? (
            <DocEditor key={selected.doc.id} doc={selected.doc} todoId={todoId} />
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
