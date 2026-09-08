// Composer — a large natural-language capture surface shown in the center
// (task-detail) area when the user clicks 新建任务. Supports freeform text +
// pasted/dropped images, previews the structured fields the AI parser extracts,
// files the new task into a chosen group (directory), and opens it on submit.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGroups } from '../hooks/useThihyApi';
import type { ParsedTodo } from '../../shared/ai-types';
import type { Priority } from '../../shared/todo-types';

interface PastedImage {
  id: string;
  url: string; // object URL for preview
  blob: Blob;
  name: string;
  mime: string;
}

export const Composer: React.FC<{
  onClose: () => void;
  navigate: (to: string) => void;
  defaultGroupId?: string | null;
}> = ({ onClose, navigate, defaultGroupId }) => {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PastedImage[]>([]);
  const [groupId, setGroupId] = useState<string | null>(defaultGroupId ?? null);
  const [preview, setPreview] = useState<ParsedTodo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupsApi = useGroups();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Esc cancels; Ctrl+Enter submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, images, groupId]);

  // Live preview of how the capture will be parsed.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!text.trim() && images.length === 0) {
        if (!cancelled) setPreview(null);
        return;
      }
      const res = await window.thihy.ai.parseCapturePreview(text || ' ');
      if (!cancelled && res.ok) setPreview(res.data);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, images.length]);

  const addBlob = useCallback((blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    setImages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), url, blob, name: name || 'pasted', mime: blob.type },
    ]);
  }, []);

  // Paste images directly into the textarea.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let handled = false;
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            addBlob(file, file.name || 'pasted');
            handled = true;
          }
        }
      }
      if (handled) e.preventDefault();
    },
    [addBlob],
  );

  // Drag-and-drop images onto the composer.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const f of files) {
        if (f.type.startsWith('image/')) addBlob(f, f.name);
      }
    },
    [addBlob],
  );

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      // Parse NL into structured fields; fall back to first line if unavailable.
      let parsed: ParsedTodo = {
        title: trimmed.split('\n').map((l) => l.trim()).find(Boolean) || '(无标题)',
        dueAt: null,
        priority: 'none' as Priority,
        project: null,
        tags: [],
      };
      if (trimmed) {
        const res = await window.thihy.ai.parseCapturePreview(trimmed);
        if (res.ok && res.data) parsed = res.data;
      }

      const createRes = await window.thihy.todo.create({
        title: parsed.title,
        priority: parsed.priority,
        dueAt: parsed.dueAt,
        tags: parsed.tags,
        groupId,
      });
      if (!createRes.ok) throw new Error(createRes.message || 'create_failed');
      const todoId = createRes.data.id;

      // Keep the full text as the body so nothing typed is lost.
      if (trimmed) {
        await window.thihy.content.writeBody(todoId, trimmed);
      }

      // Attach pasted images.
      for (const img of images) {
        const dataUrl = await blobToDataUrl(img.blob);
        await window.thihy.inbox.attachBlob({
          todoId,
          dataUrl,
          filename: img.name,
          mime: img.mime,
        });
      }

      // Free object URLs then navigate to the created task.
      images.forEach((i) => URL.revokeObjectURL(i.url));
      onClose();
      navigate(`#/todo/${todoId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="composer"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <header className="composer__head">
        <h2 className="composer__title">新建任务</h2>
        <div className="composer__actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={submitting || (!text.trim() && images.length === 0)}
            onClick={() => void submit()}
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      <div className="composer__field">
        <label className="field-label">分组</label>
        <select
          className="input"
          value={groupId ?? ''}
          onChange={(e) => setGroupId(e.target.value || null)}
        >
          <option value="">未分组</option>
          {flatten(groupsApi.groups).map((g) => (
            <option key={g.id} value={g.id}>
              {g.path}
            </option>
          ))}
        </select>
      </div>

      <textarea
        ref={textareaRef}
        className="composer__textarea"
        placeholder="用自然语言描述任务…  支持 #标签  !高/中/低 优先级  明天 / 下周三 / 12-25 截止日期。可直接粘贴或拖入图片。"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        rows={12}
      />

      {images.length > 0 && (
        <div className="composer__images">
          {images.map((img) => (
            <div key={img.id} className="composer__image">
              <img src={img.url} alt={img.name} />
              <button
                type="button"
                className="composer__image-remove"
                aria-label="移除图片"
                onClick={() => {
                  URL.revokeObjectURL(img.url);
                  setImages((prev) => prev.filter((i) => i.id !== img.id));
                }}
              >
                ×
              </button>
              <span className="composer__image-name">{img.name}</span>
            </div>
          ))}
        </div>
      )}

      {preview && (preview.tags.length > 0 || preview.dueAt || preview.priority !== 'none') && (
        <div className="composer__preview" aria-live="polite">
          {preview.priority !== 'none' && (
            <span className="chip chip--prio">优先级 {PRIORITY_LABEL[preview.priority]}</span>
          )}
          {preview.dueAt && (
            <span className="chip">📅 {new Date(preview.dueAt).toLocaleDateString()}</span>
          )}
          {preview.tags.map((t) => (
            <span key={t} className="chip chip--tag">#{t}</span>
          ))}
        </div>
      )}

      {error && <div className="composer__error">{error}</div>}

      <footer className="composer__foot">
        <span className="composer__hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消 · 粘贴/拖入图片
        </span>
      </footer>
    </div>
  );
};

const PRIORITY_LABEL: Record<Priority, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Flatten the group tree into a path-prefixed list for the <select>.
function flatten(groups: { id: string; name: string; parentId: string | null }[]): {
  id: string;
  path: string;
}[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const pathOf = (id: string): string => {
    const g = byId.get(id);
    if (!g) return '';
    if (!g.parentId) return g.name;
    const parent = pathOf(g.parentId);
    return parent ? `${parent} / ${g.name}` : g.name;
  };
  return groups.map((g) => ({ id: g.id, path: pathOf(g.id) }));
}
