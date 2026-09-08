// Composer — clean NL capture surface shown in the center when the user
// clicks 新建任务. Captures text + pasted/dropped images, then on Enter
// dispatches a window event so the right-side AI assistant can pick it up
// and use its todo.create tools to file it under the right group, with the
// right priority / status / tags.
//
// Why send to the AI instead of creating the task directly:
// - The AI knows the user's existing groups, current workload, and recent
//   project context, so it can pick the right group / priority / due-date
//   automatically — no more "未分组" placeholder or manual priority click.
// - The user keeps typing natural-language descriptions; the AI does the
//   structured-field extraction that the old parseCapturePreview heuristic
//   only approximated.
// - One creation path (AI) means one well-tested set of tool calls handles
//   the happy case, edge cases, and validation in one place. The Composer
//   here is a thin capture shell — the heavy lifting moved to the model.

import React, { useCallback, useEffect, useRef, useState } from 'react';

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
}

/** Fired on `window` when the user presses Enter (or clicks 发送给 AI 助手).
 *  Detail: ExternalAiSubmitDetail. The Composer does NOT create the task
 *  itself — it just hands the raw prompt + images off to the AI pane. */
export const AI_SUBMIT_EVENT = 'thihy:ai-submit-external';

export const Composer: React.FC<{
  onClose: () => void;
  navigate: (to: string) => void;
  defaultGroupId?: string | null;
}> = ({ onClose, navigate: _navigate }) => {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PastedImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        void submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, images]);

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

      const detail: ExternalAiSubmitDetail = { prompt: trimmed, images: imagePayload };
      window.dispatchEvent(new CustomEvent<ExternalAiSubmitDetail>(AI_SUBMIT_EVENT, { detail }));

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

  return (
    <div
      className="composer"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <header className="composer__head">
        <h2 className="composer__title">
          <span className="composer__title-glyph" aria-hidden="true">✦</span>
          新建任务
        </h2>
        <button
          type="button"
          className="icon-btn composer__close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          ✕
        </button>
      </header>

      <div className="composer__surface">
        <textarea
          ref={textareaRef}
          className="composer__textarea"
          placeholder="用自然语言描述这个任务，AI 助手会自动选择分组、优先级、截止日期等。"
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
      </div>

      {error && <div className="composer__error">{error}</div>}

      <footer className="composer__foot">
        <span className="composer__hint">
          回车发送给 AI 助手 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>Esc</kbd> 关闭 · 粘贴或拖入图片
        </span>
        <button
          type="button"
          className="btn-primary composer__send"
          disabled={submitting || (!text.trim() && images.length === 0)}
          onClick={() => void submit()}
        >
          {submitting ? '发送中…' : '发送给 AI 助手'}
          <span className="composer__send-glyph" aria-hidden="true">➤</span>
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
