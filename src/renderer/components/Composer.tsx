// Composer — dual-mode task creation surface. Form mode writes structured
// fields directly through todo.create; AI mode sends natural language and
// optional images through an explicitly marked task-creation request.
//
// Why send to the AI instead of creating the task directly:
// - The AI knows the user's existing tasks, current workload, and recent
//   project context, so it can pick the right priority / due-date / parent
//   task automatically — no manual field-filling.
// - The user keeps typing natural-language descriptions; the AI does the
//   structured-field extraction that the old parseCapturePreview heuristic
//   only approximated.
// - Form mode stays deterministic for users who already know the fields.
// - AI mode handles extraction, ambiguity and existing-task relationships.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconClose, IconSend } from './icons';
import type { Priority, TodoStatus } from '../../shared/todo-types';

interface PastedImage {
  id: string;
  url: string; // object URL for preview
  blob: Blob;
  name: string;
  mime: string;
}

/** Shape of the window event fired on submit. The AIPane listens for this
 *  and feeds it into its own submit pipeline. Exported so consumers (and
 *  tests) can build the event payload without re-declaring the shape. */
export interface ExternalAiSubmitDetail {
  /** The literal text the user typed (no image references inline — those
   *  live in `images` and the AIPane renders them as image markdown). */
  prompt: string;
  /** Images attached to this prompt as data URLs. The AIPane embeds them
   *  in the wire prompt as `![name](dataUrl)` so a multimodal model sees
   *  them inline. */
  images: { name: string; mime: string; dataUrl: string }[];
  /** Explicit source contract: the receiver must wrap this as a task-create
   * request instead of treating it as ordinary assistant chat. */
  intent: 'create-task';
}

/** Fired on `window` when the user presses Enter (or clicks 发送给 AI 助手).
 *  Detail: ExternalAiSubmitDetail. The Composer does NOT create the task
 *  itself — it just hands the raw prompt + images off to the AI pane. */
export const AI_SUBMIT_EVENT = 'todo-list:ai-submit-external';

export const Composer: React.FC<{
  onClose: () => void;
  navigate: (to: string) => void;
  onAiSubmit?: (detail: ExternalAiSubmitDetail) => void;
}> = ({ onClose, navigate, onAiSubmit }) => {
  const [mode, setMode] = useState<'form' | 'ai'>('form');
  const [text, setText] = useState('');
  const [images, setImages] = useState<PastedImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    status: 'next' as TodoStatus,
    priority: 'none' as Priority,
    dueDate: '',
    tags: '',
    plannedToday: false,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Esc cancels; Enter submits. (Ctrl+Enter is also accepted for users who
  // reflexively hit it from other editors; Shift+Enter still inserts a
  // newline inside the textarea.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Submit on plain Enter (textarea also sees Shift+Enter = newline),
      // OR Ctrl/Cmd+Enter for users who prefer the explicit modifier.
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        document.activeElement === textareaRef.current
      ) {
        e.preventDefault();
        if (mode === 'ai') void submitAi();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, images, mode]);

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

  const submitAi = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Convert image blobs to data URLs in parallel; this is the only
      // blocking work between "Enter pressed" and "AI pane receives the
      // event". The encode is cheap (sub-100ms for typical screenshots)
      // so we don't need a streaming preview.
      const imagePayload = await Promise.all(
        images.map(async (img) => ({
          name: img.name,
          mime: img.mime,
          dataUrl: await blobToDataUrl(img.blob),
        })),
      );

      const detail: ExternalAiSubmitDetail = { intent: 'create-task', prompt: trimmed, images: imagePayload };
      if (onAiSubmit) onAiSubmit(detail);
      else window.dispatchEvent(new CustomEvent<ExternalAiSubmitDetail>(AI_SUBMIT_EVENT, { detail }));

      // Free the object URLs we created for previews — they're not needed
      // after we have the data URLs, and leaking them would balloon memory
      // if the user captures a lot of images in one session.
      images.forEach((i) => URL.revokeObjectURL(i.url));

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const submitForm = async (): Promise<void> => {
    const title = form.title.trim();
    if (!title || submitting) return;
    setSubmitting(true);
    setError(null);
    const tags = form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    const dueAt = form.dueDate
      ? new Date(`${form.dueDate}T23:59:59.999`).getTime()
      : undefined;
    const today = new Date();
    const plannedFor = form.plannedToday
      ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      : undefined;
    try {
      const res = await window.todoList.todo.create({
        title,
        status: form.status,
        priority: form.priority,
        ...(tags.length ? { tags } : {}),
        ...(dueAt != null && Number.isFinite(dueAt) ? { dueAt } : {}),
        ...(plannedFor ? { plannedFor } : {}),
      });
      if (!res.ok) throw new Error(res.message ?? '创建任务失败');
      onClose();
      navigate(`#/todo/${res.data.id}`);
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
        <button
          type="button"
          className="icon-btn composer__close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <IconClose size={14} />
        </button>
      </header>

      <div className="composer__mode-tabs" role="tablist" aria-label="创建方式">
        <button type="button" role="tab" aria-selected={mode === 'form'} className={mode === 'form' ? 'is-active' : ''} onClick={() => setMode('form')}>
          表单创建
        </button>
        <button type="button" role="tab" aria-selected={mode === 'ai'} className={mode === 'ai' ? 'is-active' : ''} onClick={() => setMode('ai')}>
          AI 创建
        </button>
      </div>

      {mode === 'ai' ? <div className="composer__surface">
        <textarea
          ref={textareaRef}
          className="composer__textarea"
          placeholder="用自然语言描述这个任务，AI 助手会自动选择优先级、截止日期、父任务等。"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          rows={10}
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
      </div> : <div className="composer__form">
        <label className="composer__field composer__field--wide">
          <span>任务标题</span>
          <input autoFocus value={form.title} onChange={(e) => setForm((v) => ({ ...v, title: e.target.value }))} placeholder="输入要完成的事项" />
        </label>
        <label className="composer__field">
          <span>状态</span>
          <select value={form.status} onChange={(e) => setForm((v) => ({ ...v, status: e.target.value as TodoStatus }))}>
            <option value="next">未完成</option><option value="doing">进行中</option><option value="blocked">阻塞中</option><option value="done">已完成</option><option value="cancelled">已取消</option>
          </select>
        </label>
        <label className="composer__field">
          <span>优先级</span>
          <select value={form.priority} onChange={(e) => setForm((v) => ({ ...v, priority: e.target.value as Priority }))}>
            <option value="none">无</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </label>
        <label className="composer__field">
          <span>截止日期</span>
          <input type="date" value={form.dueDate} onChange={(e) => setForm((v) => ({ ...v, dueDate: e.target.value }))} />
        </label>
        <label className="composer__field composer__field--wide">
          <span>标签</span>
          <input value={form.tags} onChange={(e) => setForm((v) => ({ ...v, tags: e.target.value }))} placeholder="多个标签用逗号分隔" />
        </label>
        <label className="composer__today">
          <input type="checkbox" checked={form.plannedToday} onChange={(e) => setForm((v) => ({ ...v, plannedToday: e.target.checked }))} />
          加入今日待办
        </label>
      </div>}

      {error && <div className="composer__error">{error}</div>}

      <footer className="composer__foot">
        <span className="composer__hint">{mode === 'ai' ? <>回车交给 AI 创建 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · 可粘贴图片</> : '填写明确字段后直接创建，不经过 AI'}</span>
        <button
          type="button"
          className="btn-primary composer__send"
          disabled={submitting || (mode === 'ai' ? (!text.trim() && images.length === 0) : !form.title.trim())}
          onClick={() => void (mode === 'ai' ? submitAi() : submitForm())}
        >
          {submitting ? '创建中…' : mode === 'ai' ? '交给 AI 创建' : '创建任务'}
          <IconSend size={14} className="composer__send-glyph" />
        </button>
      </footer>
    </div>
  );
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
