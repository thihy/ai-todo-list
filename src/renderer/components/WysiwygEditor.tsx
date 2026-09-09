// WYSIWYG editor for the default progress document. Tiptap (StarterKit +
// Image + Link) backed by HTML content stored via the document model.
//
// Pasted/dropped images are persisted through inbox.attachBlob and embedded
// as <img src="attachment://<id>"> — a custom scheme the main process serves
// from the inbox_attachments table (no base64 in the document, no absolute
// path leaked to the renderer). Toolbar covers the common formatting set;
// Cmd/Ctrl-S and a 1.5s idle debounce both save.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { usePrompt } from '../hooks/usePrompt';

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const WysiwygEditor: React.FC<{
  todoId: string;
  value: string;
  version: number | null;
  onSave: (html: string) => Promise<void>;
  saving: boolean;
  error: string | null;
}> = ({ todoId, value, version, onSave, saving, error }) => {
  const [html, setHtml] = useState(value);
  const { prompt, node: promptNode } = usePrompt();
  const dirty = html !== value && html !== '';
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onSave in a ref so the debounce timer always calls the
  // freshest closure without re-arming on every keystroke.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const persistPastedImage = useCallback(
    async (file: File, editor: Editor): Promise<void> => {
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await window.thihy.inbox.attachBlob({
          todoId,
          dataUrl,
          filename: file.name || 'pasted',
          mime: file.type || 'image/png',
        });
        if (res.ok) {
          editor.chain().focus().setImage({ src: `attachment://${res.data.id}` }).run();
        }
      } catch {
        // Swallow — paste is best-effort; a failed attach shouldn't crash the editor.
      }
    },
    [todoId],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // StarterKit v3 may bundle Link; we add our own configured Link below,
        // so disable the bundled one to avoid a duplicate-extension error.
        link: false,
      }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image.configure({ inline: false, allowBase64: false }),
    ],
    content: value,
    editorProps: {
      attributes: { class: 'wysiwyg__content', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items || !editor) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              void persistPastedImage(file, editor);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || !editor) return false;
        let handled = false;
        for (const file of Array.from(files)) {
          if (file.type.startsWith('image/')) {
            void persistPastedImage(file, editor);
            handled = true;
          }
        }
        return handled;
      },
    },
    onUpdate: ({ editor }) => {
      setHtml(editor.getHTML());
    },
  });

  // When the backend version changes (e.g. data-bus refresh after an AI edit
  // or a restore), re-apply the external content — but only if the editor
  // isn't mid-edit (dirty), so we don't clobber the user's unsaved buffer.
  useEffect(() => {
    if (!editor) return;
    if (dirty) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value);
  }, [editor, value, version, dirty]);

  // Debounced autosave: 1.5s after the last edit.
  useEffect(() => {
    if (!dirty || saving) return;
    saveTimer.current = setTimeout(() => {
      void onSaveRef.current(html);
    }, 1500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [html, dirty, saving]);

  // Cmd/Ctrl-S saves immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void onSave(html);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [html, dirty, onSave]);

  // Pick an image file via the dialog and insert it.
  const pickImage = useCallback(async (): Promise<void> => {
    if (!editor) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void persistPastedImage(file, editor);
    };
    input.click();
  }, [editor, persistPastedImage]);

  if (!editor) return <div className="wysiwyg wysiwyg--loading">加载编辑器…</div>;

  const Btn: React.FC<{ onClick: () => void; active?: boolean; label: string; title: string }> = ({
    onClick,
    active,
    label,
    title,
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`wysiwyg__btn${active ? ' is-active' : ''}`}
      title={title}
      aria-pressed={active}
    >
      {label}
    </button>
  );

  return (
    <div className="wysiwyg">
      <div className="wysiwyg__toolbar">
        <Btn label="H1" title="一级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} />
        <Btn label="H2" title="二级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} />
        <Btn label="B" title="粗体" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} />
        <Btn label="I" title="斜体" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} />
        <Btn label="• 列表" title="无序列表" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} />
        <Btn label="1. 列表" title="有序列表" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} />
        <Btn label="❝" title="引用" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} />
        <Btn label="⌗" title="插入图片" onClick={pickImage} />
        <Btn
          label="🔗"
          title="链接"
          onClick={async () => {
            const prev = editor.getAttributes('link').href as string | undefined;
            const url = await prompt('链接地址', prev ?? 'https://');
            if (url == null) return;
            if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
            else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
          }}
          active={editor.isActive('link')}
        />
        <span className="wysiwyg__spacer" />
        {saving && <span className="wysiwyg__status">保存中…</span>}
        {error && <span className="wysiwyg__status wysiwyg__status--error">{error}</span>}
        <button
          type="button"
          className="wysiwyg__save"
          onClick={() => void onSave(html)}
          disabled={!dirty || saving}
        >
          {dirty ? '保存' : '已保存'}
        </button>
      </div>
      <EditorContent editor={editor} />
      {promptNode}
    </div>
  );
};
