// DocumentsView — the task's multi-document workspace (schema v11). Replaces
// the single legacy .md body editor with a left list + right editor surface:
//
//   ┌─────────────┬──────────────────────────────────────┐
//   │ 文档  [+]    │  (per-kind editor fills the space)    │
//   │ ▸ 进展      │                                      │
//   │   笔记      │  progress → WysiwygEditor             │
//   │   附件      │  note_md   → MarkdownEditor           │
//   │   链接      │  attachment→ preview/open/remove      │
//   │             │  link      → open url                 │
//   └─────────────┴──────────────────────────────────────┘
//
// The default progress doc (WYSIWYG) is ord 0 and auto-selected on first
// open. Drawings stay in the summary DrawingStrip (their own full editor),
// so the workspace surfaces progress / note_md / attachment / link kinds.

import React, { useCallback, useEffect, useState } from 'react';
import { useDocuments, useDocument } from '../hooks/useThihyApi';
import { WysiwygEditor } from './WysiwygEditor';
import { MarkdownEditor } from './MarkdownEditor';
import type { DocumentKind, TaskDocument } from '../../shared/todo-types';

const KIND_ICON: Record<DocumentKind, string> = {
  progress: '📝',
  note_md: '📄',
  drawing: '🎨',
  attachment: '📎',
  link: '🔗',
};

const KIND_LABEL: Record<DocumentKind, string> = {
  progress: '进展',
  note_md: '笔记',
  drawing: '绘图',
  attachment: '附件',
  link: '链接',
};

/** A delete (×) affordance on a list item. The default progress doc is
 *  not removable (it's the task's primary work surface). */
function removeDoc(doc: TaskDocument, after: () => void): void {
  if (doc.kind === 'progress') return;
  if (!window.confirm(`删除「${doc.title ?? KIND_LABEL[doc.kind]}」？`)) return;
  // For attachment docs, also drop the inbox row + file so we don't orphan
  // bytes when the list entry is removed.
  if (doc.kind === 'attachment' && doc.refId) {
    void window.thihy.inbox.remove({ id: doc.refId }).then(() => {
      void window.thihy.document.remove(doc.id).then(after);
    });
  } else {
    void window.thihy.document.remove(doc.id).then(after);
  }
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
          <span>📎 {doc.title}</span>
        </div>
      )}
      {dataUrl && (
        <a
          className="docs-workspace__open-link"
          href={dataUrl}
          download={doc.title ?? 'attachment'}
        >
          下载
        </a>
      )}
    </div>
  );
};

const LinkView: React.FC<{ doc: TaskDocument }> = ({ doc }) => (
  <div className="docs-workspace__link">
    <span className="docs-workspace__link-title">🔗 {doc.title}</span>
    <a className="docs-workspace__open-link" href={doc.url ?? '#'} target="_blank" rel="noreferrer">
      {doc.url}
    </a>
  </div>
);

export const DocumentsView: React.FC<{
  todoId: string;
}> = ({ todoId }) => {
  const { documents, refresh } = useDocuments(todoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Auto-select the progress doc (first, ord 0) when the list loads or the
  // selection is no longer present (e.g. after a delete).
  useEffect(() => {
    if (documents.length === 0) return;
    if (!selectedId || !documents.some((d) => d.id === selectedId)) {
      setSelectedId(documents[0]!.id);
    }
  }, [documents, selectedId]);

  const selected = documents.find((d) => d.id === selectedId) ?? null;

  const addNote = useCallback(async (): Promise<void> => {
    const res = await window.thihy.document.create({ todoId, kind: 'note_md', title: '笔记' });
    if (res.ok) {
      await refresh();
      setSelectedId(res.data.id);
    }
    setAddOpen(false);
  }, [todoId, refresh]);

  const addLink = useCallback(async (): Promise<void> => {
    const url = window.prompt('链接地址', 'https://');
    if (!url) {
      setAddOpen(false);
      return;
    }
    const title = window.prompt('链接名称（可留空）') || new URL(url).hostname;
    const res = await window.thihy.document.create({ todoId, kind: 'link', title, url });
    if (res.ok) {
      await refresh();
      setSelectedId(res.data.id);
    }
    setAddOpen(false);
  }, [todoId, refresh]);

  const addAttachment = useCallback(async (): Promise<void> => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        setAddOpen(false);
        return;
      }
      // Read as data URL to feed attachBlob.
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
          setSelectedId(docRes.data.id);
        }
      }
      setAddOpen(false);
    };
    input.click();
  }, [todoId, refresh]);

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

  return (
    <div className="docs-workspace">
      <aside className="docs-workspace__sidebar">
        <div className="docs-workspace__sidebar-head">
          <span className="docs-workspace__sidebar-title">文档</span>
          <div className="docs-workspace__add">
            <button
              type="button"
              className="docs-workspace__add-btn"
              onClick={() => setAddOpen((v) => !v)}
              title="新增文档"
            >
              +
            </button>
            {addOpen && (
              <div className="docs-workspace__add-menu">
                <button type="button" onClick={addNote}>📄 笔记 (Markdown)</button>
                <button type="button" onClick={addAttachment}>📎 附件</button>
                <button type="button" onClick={addLink}>🔗 链接</button>
              </div>
            )}
          </div>
        </div>
        <ul className="docs-workspace__doc-list">
          {documents.map((d) => (
            <li
              key={d.id}
              className={`docs-workspace__doc-item${d.id === selectedId ? ' is-active' : ''}`}
              onClick={() => setSelectedId(d.id)}
            >
              <span className="docs-workspace__doc-icon">{KIND_ICON[d.kind]}</span>
              <span className="docs-workspace__doc-title">{d.title ?? KIND_LABEL[d.kind]}</span>
              {d.kind !== 'progress' && (
                <button
                  type="button"
                  className="docs-workspace__doc-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDoc(d, refresh);
                  }}
                  title="删除"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
      <div className="docs-workspace__editor">
        {selected ? (
          <DocEditor key={selected.id} doc={selected} todoId={todoId} />
        ) : (
          <div className="docs-workspace__empty">选择左侧文档开始编辑</div>
        )}
      </div>
    </div>
  );
};
