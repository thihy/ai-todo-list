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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDocuments, useDocument, useDrawings } from '../hooks/useThihyApi';
import { usePrompt } from '../hooks/usePrompt';
import { routeToHash } from '../router';
import { WysiwygEditor } from './WysiwygEditor';
import { MarkdownEditor } from './MarkdownEditor';
import {
  IconActivity,
  IconAttach,
  IconClose,
  IconDoc,
  IconDrawing,
  IconLink,
  IconPlus,
} from './icons';
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
function removeTab(tab: Tab, after: () => void, navigate: (to: string) => void): void {
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
  void navigate;
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

/** Drawing tab body: thumbnail + an affordance to open the full Excalidraw
 *  editor (drawings have their own route). */
const DrawingView: React.FC<{
  drawingId: string;
  title: string | null;
  thumb: string | null;
  onOpen: () => void;
}> = ({ title, thumb, onOpen }) => (
  <div className="docs-workspace__drawing">
    {thumb ? (
      <img className="docs-workspace__drawing-thumb" src={thumb} alt={title ?? '绘图'} />
    ) : (
      <div className="docs-workspace__drawing-empty">无预览</div>
    )}
    <button type="button" className="docs-workspace__open-btn" onClick={onOpen}>
      打开绘图编辑器
    </button>
  </div>
);

export const DocumentsView: React.FC<{
  todoId: string;
  navigate: (to: string) => void;
}> = ({ todoId, navigate }) => {
  const { documents, refresh } = useDocuments(todoId);
  const { drawings, refresh: refreshDrawings } = useDrawings(todoId);
  const { prompt, node: promptNode } = usePrompt();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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

  // 绘图: open the Excalidraw route in "new drawing" mode; the editor
  // creates the drawing on first save. Refresh the tab list when the user
  // returns (the data-bus drawings scope will also refresh it).
  const addDrawing = useCallback((): void => {
    navigate(routeToHash({ name: 'todo-drawing', id: todoId }));
    setAddOpen(false);
  }, [navigate, todoId]);

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

  return (
    <div className="docs-workspace docs-workspace--tabs">
      <div className="docs-workspace__tabbar">
        <div className="docs-workspace__tabs" role="tablist">
          {tabs.map((t) => {
            const kind: DocumentKind = t.kind === 'document' ? t.doc.kind : 'drawing';
            const Icon = KIND_ICON[kind]!;
            const id = tabId(t);
            const title = t.kind === 'document' ? t.doc.title ?? KIND_LABEL[t.doc.kind] : t.title ?? '绘图';
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === selectedId}
                className={`docs-workspace__tab${id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(id)}
                title={title}
              >
                <Icon size={14} />
                <span className="docs-workspace__tab-label">{title}</span>
                {!(t.kind === 'document' && t.doc.kind === 'progress') && (
                  <span
                    role="button"
                    className="docs-workspace__tab-close"
                    aria-label="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(t, refreshAll, navigate);
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
            <DrawingView
              drawingId={selected.id}
              title={selected.title}
              thumb={selected.thumb}
              onOpen={() => navigate(routeToHash({ name: 'todo-drawing', id: todoId, drawingId: selected.id }))}
            />
          )
        ) : (
          <div className="docs-workspace__empty">选择上方标签开始编辑</div>
        )}
      </div>
      {promptNode}
    </div>
  );
};
