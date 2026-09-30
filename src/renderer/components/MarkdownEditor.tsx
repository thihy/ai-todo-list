// Markdown editor — write / preview / split views with a format toolbar and
// power-user keyboard shortcuts. The source editor is a styled <textarea>
// (no CodeMirror dep). The preview renders GFM (tables, task lists, strike-
// through) via `marked`, sanitised with DOMPurify, plus Mermaid diagrams:
// ```mermaid blocks become <div class="mermaid"> placeholders, then
// `mermaid.run` replaces them with live SVG after sanitisation. Mermaid is
// dynamically imported only when a diagram is present.
//
// Toolbar + keymap (the parts that make the editor feel "rich", not crude):
//   - Toolbar buttons wrap the selection with the matching markers
//     (**...**, *...*, ~~...~~, `...`, [..](..)) or toggle a line prefix
//     (# / ## / ### / > / - / 1. / - [ ] / ``` / ---). Empty selection +
//     placeholder gives `**粗体**` etc. so the user can keep typing.
//   - Cmd/Ctrl+B (bold), Cmd/Ctrl+I (italic), Cmd/Ctrl+K (link).
//   - Tab indents (2 spaces, per selected line), Shift+Tab outdents.
//   - Enter continues the current list / quote block; an empty marker exits.
//   - Backspace at column 0 of an empty list item removes the marker.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconBold,
  IconCode,
  IconCodeBlock,
  IconDivider,
  IconItalic,
  IconLink,
  IconListCheck,
  IconListOl,
  IconListUl,
  IconQuote,
  IconSave,
  IconStrike,
} from './icons';
import { MarkdownText, type MarkdownLabels, type MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives';
import { HistoryPopover } from './HistoryPopover';

/** A textarea + value transform, returning the new value and selection. */
interface EditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Wrap the textarea's selection (or insert markers around a placeholder).
 *  `placeholder` is what gets selected when there is no active selection so
 *  the user can just keep typing to replace it. */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  value: string,
  before: string,
  after: string,
  placeholder: string,
): EditResult {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);
  const inner = selected || placeholder;
  const next =
    value.slice(0, start) + before + inner + after + value.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + inner.length;
  return { value: next, selectionStart: selStart, selectionEnd: selEnd };
}

/** Find the [start, end) of the line containing `pos`. */
function lineRange(value: string, pos: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  const nl = value.indexOf('\n', pos);
  const end = nl === -1 ? value.length : nl;
  return { start, end };
}

/** Apply a transform to a single line and return the new value + selection.
 *  `transform` receives the line text and returns the new line. */
function transformLine(
  value: string,
  pos: number,
  transform: (line: string) => string,
): { value: string; caret: number } {
  const { start, end } = lineRange(value, pos);
  const line = value.slice(start, end);
  const nextLine = transform(line);
  const next = value.slice(0, start) + nextLine + value.slice(end);
  // Keep caret roughly in place; clamp to the new line bounds.
  const caret = Math.min(pos + (nextLine.length - line.length), start + nextLine.length);
  return { value: next, caret };
}

/** Indent every selected line (or the current line) by `indent` spaces.
 *  Returns the new value and a sensible caret. */
function indentLines(
  textarea: HTMLTextAreaElement,
  value: string,
  indent: string,
): EditResult {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const { start: ls } = lineRange(value, start);
  const { end: le } = lineRange(value, end);
  const block = value.slice(ls, le);
  const indented = block
    .split('\n')
    .map((l) => indent + l)
    .join('\n');
  const next = value.slice(0, ls) + indented + value.slice(le);
  return {
    value: next,
    selectionStart: start + indent.length,
    selectionEnd: end + indent.length * (block.split('\n').length),
  };
}

/** Detect the leading list/quote marker on a line, if any. Returns the marker
 *  text and the body offset, or null if there is no marker. Used by Enter
 *  continuation and Backspace marker-removal. */
type Marker =
  | { kind: 'ul'; marker: string; bodyStart: number }
  | { kind: 'ol'; marker: string; number: number; bodyStart: number }
  | { kind: 'task'; marker: string; bodyStart: number }
  | { kind: 'quote'; marker: string; bodyStart: number };

function detectMarker(line: string): Marker | null {
  const ul = line.match(/^(\s*)([-*+])\s/) ?? line.match(/^(\s*)([-*+])\s*$/);
  if (ul && ul[2]) {
    return { kind: 'ul', marker: `${ul[1] ?? ''}${ul[2]} `, bodyStart: (ul[1]?.length ?? 0) + 2 };
  }
  const task = line.match(/^(\s*)([-*+])\s\[( |x|X)\]\s/);
  if (task) {
    return {
      kind: 'task',
      marker: `${task[1] ?? ''}${task[2]} [ ] `,
      bodyStart: (task[1]?.length ?? 0) + 6,
    };
  }
  const ol = line.match(/^(\s*)(\d+)\.\s/);
  if (ol && ol[2]) {
    return {
      kind: 'ol',
      marker: `${ol[1] ?? ''}${ol[2]}. `,
      number: Number(ol[2]),
      bodyStart: (ol[1]?.length ?? 0) + ol[2].length + 2,
    };
  }
  const quote = line.match(/^(\s*)>\s/);
  if (quote) {
    return { kind: 'quote', marker: `${quote[1] ?? ''}> `, bodyStart: (quote[1]?.length ?? 0) + 2 };
  }
  return null;
}

/** Compute the continuation marker for an Enter press on a line that carries
 *  a list/quote marker. Returns null if Enter should just insert a newline
 *  (no marker). `empty` means the line body is empty → exit the list. */
function continuationMarker(line: string): { insert: string; exit: boolean } | null {
  const m = detectMarker(line);
  if (!m) return null;
  const body = line.slice(m.bodyStart);
  const isEmpty = body.trim() === '';
  if (m.kind === 'ul') {
    return isEmpty ? { insert: '', exit: true } : { insert: `\n${m.marker}`, exit: false };
  }
  if (m.kind === 'task') {
    return isEmpty ? { insert: '', exit: true } : { insert: `\n${m.marker}`, exit: false };
  }
  if (m.kind === 'ol') {
    if (isEmpty) return { insert: '', exit: true };
    const next = m.number + 1;
    const indent = m.marker.match(/^\s*/)?.[0] ?? '';
    return { insert: `\n${indent}${next}. `, exit: false };
  }
  // quote
  return isEmpty ? { insert: '', exit: false } : { insert: `\n${m.marker}`, exit: false };
  // Quote never "exits" with empty; the user has to delete the > manually
  // (matches GitHub's behaviour).
}

/** Persist the 编辑 / 预览 / 分屏 mode across DocumentsView remounts (e.g. the
 *  fullscreen-doc toggle unmounts DocumentsView when TodoEditorPane unmounts
 *  and remounts inside FullscreenDoc) AND across app restarts. Without
 *  persistence the user lands back on '编辑' every time they toggle
 *  fullscreen or reopen the app, even if they were reading in 预览. */
const MD_VIEW_STORAGE_KEY = 'todo-list.mdView';
const MD_VIEW_VALUES = ['write', 'preview', 'split'] as const;
type MdView = typeof MD_VIEW_VALUES[number];

function loadMdView(): MdView {
  try {
    const v = localStorage.getItem(MD_VIEW_STORAGE_KEY);
    if (MD_VIEW_VALUES.includes(v as MdView)) return v as MdView;
  } catch {
    /* localStorage may be disabled (private mode, sandbox, tests) — fall
       through to the default and silently skip persistence below. */
  }
  return 'write';
}

export const MarkdownEditor: React.FC<{
  docId: string;
  /** The task this document belongs to. Needed for image paste so the editor
   *  can drop the uploaded attachment into `{todosDir}/{slug}/attachments/`.
   *  When omitted (legacy callers), image paste is a no-op — the existing
   *  documents get the same default behaviour they had before this field
   *  existed. */
  todoId?: string;
  value: string;
  version: number | null;
  onSave: (markdown: string) => Promise<void>;
  saving: boolean;
  error: string | null;
}> = ({ docId, todoId, value, version, onSave, saving, error }) => {
  const [md, setMd] = useState(value);
  const [view, setView] = useState<MdView>(loadMdView);
  const setViewPersisted = useCallback((next: MdView): void => {
    setView(next);
    try {
      localStorage.setItem(MD_VIEW_STORAGE_KEY, next);
    } catch {
      /* best-effort persistence — UI still updates in-memory */
    }
  }, []);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirty = md !== value && md !== '';
  // Wrap onSave so we can stamp lastSavedAt when the round-trip resolves —
  // the status bar reads it to show "已保存 HH:MM:SS" after a save.
  const onSaveWrapped = useCallback(
    async (text: string): Promise<void> => {
      await onSave(text);
      setLastSavedAt(Date.now());
    },
    [onSave],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 跟踪当前正文 —— applyEdit 之后立即同步。异步上传完成后要做
  // 「占位 → attachment://<id>」替换时，闭包里的 md 早已过期（用户
  // 可能又改了正文，或前面那张图的 replaceRange 还没 commit），用
  // 这个 ref 拿最新值做 indexOf 才对得上。
  const mdRef = useRef<string>(value);
  useEffect(() => {
    mdRef.current = md;
  }, [md]);
  // Apply an edit and restore the textarea's selection on the next paint so
  // the user sees it where the transform put it.
  const applyEdit = useCallback((next: EditResult): void => {
    mdRef.current = next.value;
    setMd(next.value);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }, []);

  // Re-sync from the backend when not dirty.
  useEffect(() => {
    if (dirty) return;
    if (md === value) return;
    setMd(value);
  }, [value, version, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd/Ctrl-S saves immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void onSaveWrapped(md);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [md, dirty, onSave]);

  const doWrap = (before: string, after: string, placeholder: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    applyEdit(wrapSelection(ta, md, before, after, placeholder));
  };

  const doLine = (prefix: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const r = transformLine(md, ta.selectionStart, (line) => {
      const m = line.match(/^(#+ |\d+\. |[-*+] |[-*+] \[[ x]\] |> )/);
      if (m && m[1]) return prefix + line.slice(m[1].length);
      return prefix + line;
    });
    applyEdit({
      value: r.value,
      selectionStart: r.caret,
      selectionEnd: r.caret,
    });
  };

  const insertAtCursor = (text: string, selStartOffset = 0, selEndOffset = 0): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = md.slice(0, start) + text + md.slice(end);
    const caret = start + text.length - (text.length - selStartOffset);
    const selStart = start + selStartOffset;
    const selEnd = start + text.length - selEndOffset;
    applyEdit({ value: next, selectionStart: selStart, selectionEnd: selEnd });
    void caret;
  };

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    const meta = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+B / I / K — format shortcuts.
    if (meta && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); doWrap('**', '**', '粗体'); return; }
      if (k === 'i') { e.preventDefault(); doWrap('*', '*', '斜体'); return; }
      if (k === 'k') {
        e.preventDefault();
        // Wrap selection as link text; if nothing selected, insert placeholder.
        const sel = md.slice(ta.selectionStart, ta.selectionEnd);
        const inner = sel || '链接文字';
        const next =
          md.slice(0, ta.selectionStart) + `[${inner}](https://)` + md.slice(ta.selectionEnd);
        const selStart = ta.selectionStart + inner.length + 3; // inside (https://)
        const selEnd = selStart + 'https://'.length;
        applyEdit({ value: next, selectionStart: selStart, selectionEnd: selEnd });
        return;
      }
    }

    // Tab / Shift+Tab — indent / outdent.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        // Remove leading indent (up to 2 spaces) from each line in selection.
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const { start: ls } = lineRange(md, start);
        const { end: le } = lineRange(md, end);
        const block = md.slice(ls, le);
        const stripped = block
          .split('\n')
          .map((l) => l.replace(/^( {1,2})/, ''))
          .join('\n');
        const removed = block.length - stripped.length;
        const next = md.slice(0, ls) + stripped + md.slice(le);
        applyEdit({
          value: next,
          selectionStart: Math.max(ls, start - 2),
          selectionEnd: Math.max(ls, end - removed),
        });
      } else {
        applyEdit(indentLines(ta, md, '  '));
      }
      return;
    }

    // Enter — list / quote continuation.
    if (e.key === 'Enter' && !e.shiftKey) {
      const { start: ls } = lineRange(md, ta.selectionStart);
      const { end: le } = lineRange(md, ta.selectionStart);
      const line = md.slice(ls, le);
      const cont = continuationMarker(line);
      if (cont) {
        e.preventDefault();
        const insert = cont.exit ? '' : cont.insert;
        const next = md.slice(0, le) + insert + md.slice(le);
        const caret = le + insert.length;
        applyEdit({ value: next, selectionStart: caret, selectionEnd: caret });
        return;
      }
    }

    // Backspace at column 0 of an empty list item — remove the marker so the
    // user can keep typing without an orphan bullet.
    if (e.key === 'Backspace') {
      const { start: ls } = lineRange(md, ta.selectionStart);
      if (ta.selectionStart === ls) {
        const lineEnd = md.indexOf('\n', ls);
        const line = md.slice(ls, lineEnd === -1 ? md.length : lineEnd);
        const m = detectMarker(line);
        if (m && line.slice(m.bodyStart).trim() === '') {
          e.preventDefault();
          const stripped = line.slice(m.marker.length);
          const replaced = md.slice(0, ls) + stripped + md.slice(ls + line.length);
          applyEdit({ value: replaced, selectionStart: ls, selectionEnd: ls });
          return;
        }
      }
    }
  };

  // 粘贴图片 → 走 inbox.attachBlob 落到任务的 attachments/，并把图片引用
  // 插入到当前光标位置。插入格式 `![pasted-YYYYMMDD-HHMMSS](attachment://<id>)`，
  // 协议 attachment:// 已在 main 注册，<img> 预览能直接渲染字节流。
  //
  // 行为细节：
  //   - 只处理 ClipboardItem.kind === 'file' && type.startsWith('image/') 的项；
  //     文本粘贴走 textarea 默认行为不变。
  //   - 多个图片同时粘贴，按当前顺序依次在光标处插入，每张一行。
  //   - 上传在 fire-and-forget 异步任务里跑：先插入占位 `![...](attachment://pending/<key>)`，
  //     落盘成功后替换为真实 id，失败则把占位行换成错误提示。
  //   - 没有 todoId 的旧调用方不接 paste（保持原有行为）。
  const [pasteError, setPasteError] = useState<string | null>(null);

  // 6 秒后自动清掉粘贴错误提示，避免一直挂在工具栏挡视线。文件已经按
  // 占位回退/错误注释的形式留在正文里 —— 提示只是一个瞬时信号。
  useEffect(() => {
    if (!pasteError) return;
    const t = window.setTimeout(() => setPasteError(null), 6_000);
    return () => window.clearTimeout(t);
  }, [pasteError]);

  const insertTextAtCursor = useCallback((text: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = md.slice(0, start) + text + md.slice(end);
    const caret = start + text.length;
    applyEdit({ value: next, selectionStart: caret, selectionEnd: caret });
  }, [md, applyEdit]);

  const replaceRange = useCallback((find: string, replacement: string): void => {
    // 替换首次出现的 `find` 字符串（占位行），并把光标落在替换末尾。
    //
    // 调用方经常是异步上传结束后的回调 —— 那时 React 状态 md 早已被其他
    // 路径更新过（用户继续输入、Ctrl+B 加粗、或前面那张图先完成替换）。
    // 用 mdRef 读最新的正文做 indexOf，才能保证多图并发上传时各自的占位
    // 都被精准替换，而不是被一次替换覆盖成同一个 id。
    const current = mdRef.current;
    const idx = current.indexOf(find);
    if (idx === -1) return;
    const end = idx + find.length;
    const next = current.slice(0, idx) + replacement + current.slice(end);
    const caret = idx + replacement.length;
    applyEdit({ value: next, selectionStart: caret, selectionEnd: caret });
  }, [applyEdit]);

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items;
    if (!items || !todoId) return;
    const images: File[] = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length === 0) return;
    e.preventDefault();

    // 给每张图一个 stable placeholder key（"paste-<timestamp>-<index>"），
    // 上传完成后用这个 key 精准替换。同一秒内多张也安全 —— index 不同。
    const ts = Date.now();
    const placeholders: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const key = `paste-${ts}-${i}`;
      const alt = `pasted-${formatStamp(ts)}-${i + 1}`;
      placeholders.push(`![${alt}](attachment://pending/${key})`);
    }
    // 块间留空行，避免和正文挤在一起
    const block = images.length === 1 ? placeholders[0]! : placeholders.join('\n\n');
    insertTextAtCursor(block);

    // 真正的上传：每张图一个独立 promise，互不阻塞。
    //
    // 注意：替换占位时直接读 mdRef（applyEdit 同步更新），而不是闭包里的 md
    // 状态 —— 上传是 fire-and-forget，等 promise resolve 时闭包里的 md 早已
    // 不是最新值（中间还可能有用户继续打字触发的 setMd，或前面那张图的
    // replaceRange 已经替换完）。读 mdRef 才是用户当前看到的正文。
    images.forEach((file, i) => {
      const key = `paste-${ts}-${i}`;
      const placeholder = `![${`pasted-${formatStamp(ts)}-${i + 1}`}](attachment://pending/${key})`;
      void (async () => {
        try {
          const dataUrl = await blobToDataUrl(file);
          const res = await window.todoList.inbox.attachBlob({
            todoId,
            dataUrl,
            filename: file.name || 'pasted.png',
            mime: file.type,
          });
          if (!res.ok) throw new Error(res.message ?? res.code ?? '上传失败');
          const id = res.data.id;
          replaceRange(placeholder, `![${`pasted-${formatStamp(ts)}-${i + 1}`}](attachment://${id})`);
        } catch (err) {
          // 落盘失败：把占位行换成一行可见错误提示，方便用户定位是哪张坏了。
          const msg = err instanceof Error ? err.message : String(err);
          setPasteError(`粘贴图片失败：${msg}`);
          replaceRange(placeholder, `> ⚠️ 图片上传失败：${msg}`);
        }
      })();
    });
  }, [todoId, insertTextAtCursor, replaceRange]);

  return (
    <div className="md-editor">
      {/* Format toolbar only — the 编辑/预览/分屏 mode switch was moved
          into the bottom status bar (EditorStatusBar) so the topbar stays
          a single, focused row of format affordances. Status + save still
          float right within the same row. */}
      <div className="md-editor__topbar">
        {/* Save + History sit at the START of the toolbar so the user sees
            "is my work safe?" the moment they glance at the editor —
            mirrors the WYSIWYG toolbar above. Save is icon-only (IconSave
            floppy); History opens a popover of git commits for this task. */}
        <button
          type="button"
          className={`md-editor__save md-editor__save--icon${dirty ? ' is-dirty' : ''}${saving ? ' is-saving' : ''}`}
          onClick={() => void onSaveWrapped(md)}
          disabled={!dirty || saving}
          title={dirty ? '保存 (Ctrl/Cmd+S)' : '已保存'}
          aria-label={dirty ? '保存' : '已保存'}
        >
          <IconSave size={14} />
        </button>
        <HistoryPopover docId={docId} onRestored={() => undefined} />
        {view !== 'preview' && (
          <div className="md-editor__toolbar" role="toolbar" aria-label="格式">
              <ToolbarBtn label="H1" title="一级标题 (Ctrl+Alt+1)" onClick={() => doLine('# ')}>
                <span className="md-editor__tb-text">H1</span>
              </ToolbarBtn>
              <ToolbarBtn label="H2" title="二级标题" onClick={() => doLine('## ')}>
                <span className="md-editor__tb-text">H2</span>
              </ToolbarBtn>
              <ToolbarBtn label="H3" title="三级标题" onClick={() => doLine('### ')}>
                <span className="md-editor__tb-text">H3</span>
              </ToolbarBtn>
              <span className="md-editor__tb-sep" aria-hidden="true" />
              <ToolbarBtn label="粗体" title="粗体 (Ctrl/Cmd+B)" onClick={() => doWrap('**', '**', '粗体')}>
                <IconBold size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="斜体" title="斜体 (Ctrl/Cmd+I)" onClick={() => doWrap('*', '*', '斜体')}>
                <IconItalic size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="删除线" title="删除线" onClick={() => doWrap('~~', '~~', '文字')}>
                <IconStrike size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="行内代码" title="行内代码" onClick={() => doWrap('`', '`', 'code')}>
                <IconCode size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="代码块" title="代码块" onClick={() => insertAtCursor('```\n\n```', 4, 4)}>
                <IconCodeBlock size={14} />
              </ToolbarBtn>
              <span className="md-editor__tb-sep" aria-hidden="true" />
              <ToolbarBtn label="链接" title="链接 (Ctrl/Cmd+K)" onClick={() => doWrap('[', '](https://)', '链接文字')}>
                <IconLink size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="引用" title="引用" onClick={() => doLine('> ')}>
                <IconQuote size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="无序列表" title="无序列表" onClick={() => doLine('- ')}>
                <IconListUl size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="有序列表" title="有序列表" onClick={() => doLine('1. ')}>
                <IconListOl size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="任务列表" title="任务列表" onClick={() => doLine('- [ ] ')}>
                <IconListCheck size={14} />
              </ToolbarBtn>
              <ToolbarBtn label="分割线" title="分割线" onClick={() => insertAtCursor('\n---\n')}>
                <IconDivider size={14} />
              </ToolbarBtn>
          </div>
        )}
        <span className="md-editor__spacer" />
        {saving && <span className="md-editor__status">保存中…</span>}
        {pasteError && <span className="md-editor__status md-editor__status--error">{pasteError}</span>}
        {error && <span className="md-editor__status md-editor__status--error">{error}</span>}
      </div>

      <div className={`md-editor__body md-editor__body--${view}`}>
        {view !== 'preview' && (
          <textarea
            ref={textareaRef}
            className="md-editor__textarea"
            aria-label="Markdown 正文"
            value={md}
            onChange={(e) => setMd(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
        )}
        {view !== 'write' && (
          <Preview markdown={md} />
        )}
      </div>

      {/* Status bar — word/char count + last-saved timestamp. The user
          reads it as "is my work safe + how big is it" without leaving the
          editor. Updates every second so the relative "Xs ago" stays
          honest while the user is watching. */}
      <EditorStatusBar
        text={md}
        lastSavedAt={lastSavedAt}
        saving={saving}
        dirty={dirty}
        view={view}
        onViewChange={setViewPersisted}
      />
    </div>
  );
};

/** Bottom status bar for MarkdownEditor. Shows
 *  word count, char count, and "已保存 HH:MM:SS" (or "保存中…" / "未保存" /
 *  "Xs 前已保存"). Re-renders once a second so the relative timestamp
 *  stays current. The MarkdownEditor also passes `view` / `onViewChange`
 *  to render the 编辑/预览/分屏 mode switch in the bar (it used to live
 *  in the top toolbar, but the topbar is reserved for format affordances
 *  now). */
const EditorStatusBar: React.FC<{
  text: string;
  lastSavedAt: number | null;
  saving: boolean;
  dirty: boolean;
  view?: 'write' | 'preview' | 'split';
  onViewChange?: (v: 'write' | 'preview' | 'split') => void;
}> = ({ text, lastSavedAt, saving, dirty, view, onViewChange }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (lastSavedAt === null) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [lastSavedAt]);
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;
  const chars = text.length;
  const lines = text === '' ? 0 : text.split('\n').length;
  const savedLabel = saving
    ? '保存中…'
    : dirty
      ? '未保存'
      : lastSavedAt === null
        ? '尚未保存'
        : `已保存 ${formatTimeAgo(lastSavedAt)}`;
  return (
    <div className="editor-statusbar" role="status" aria-live="polite">
      <span className="editor-statusbar__item">字数 {words}</span>
      <span className="editor-statusbar__sep" aria-hidden>·</span>
      <span className="editor-statusbar__item">字符 {chars}</span>
      <span className="editor-statusbar__sep" aria-hidden>·</span>
      <span className="editor-statusbar__item">行 {lines}</span>
      <span className="editor-statusbar__spacer" />
      {view !== undefined && onViewChange && (
        <div className="editor-statusbar__view" role="radiogroup" aria-label="视图模式">
          <button
            type="button"
            role="radio"
            aria-checked={view === 'write'}
            className={`editor-statusbar__view-btn${view === 'write' ? ' is-active' : ''}`}
            onClick={() => onViewChange('write')}
          >
            编辑
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === 'preview'}
            className={`editor-statusbar__view-btn${view === 'preview' ? ' is-active' : ''}`}
            onClick={() => onViewChange('preview')}
          >
            预览
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === 'split'}
            className={`editor-statusbar__view-btn${view === 'split' ? ' is-active' : ''}`}
            onClick={() => onViewChange('split')}
          >
            分屏
          </button>
        </div>
      )}
      <span className="editor-statusbar__sep" aria-hidden>·</span>
      <span
        className={`editor-statusbar__item editor-statusbar__save${dirty ? ' is-dirty' : ''}${saving ? ' is-saving' : ''}`}
      >
        {savedLabel}
      </span>
    </div>
  );
};

function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  return `${d} 天前`;
}

/** Toolbar button — keeps the toolbar compact. The label is for screen
 *  readers; the icon/text inside is the visible affordance. */
const ToolbarBtn: React.FC<{
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, title, onClick, children }) => (
  <button
    type="button"
    className="md-editor__tb-btn"
    aria-label={label}
    title={title}
    onMouseDown={(e) => e.preventDefault() /* don't blur the textarea */}
    onClick={onClick}
  >
    {children}
  </button>
);

const PREVIEW_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
};

const Preview: React.FC<{ markdown: string }> = ({ markdown }) => {
  // MarkdownText does GFM + KaTeX + Shiki highlighting out of the box, with
  // mermaid support added by the caller via a custom plugin if needed. We
  // fall back to a no-render placeholder when there's nothing to render so
  // the editor chrome stays in place (saves a render cycle per keystroke).
  const empty = useMemo(() => markdown.trim() === '', [markdown]);

  // 收集正文中所有 `attachment://<id>` 图片引用，去重 —— 切换 tab / 切预览
  // 视图都会触发 Preview 重渲，cache 命中就不再走 inbox.read。MarkdownText
  // 自己的协议白名单只放 http(s)/blob/data，自定义 attachment: 直接喂给
  // 它会被打回 alt 文本，所以我们用 pathImages.resolve 把 attachment://<id>
  // 翻译成 data:image/<mime>;base64,...，让它走白名单。
  const attachmentIds = useMemo(() => {
    const out = new Set<string>();
    const re = /attachment:\/\/([A-Za-z0-9_-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) out.add(m[1]!);
    return Array.from(out);
  }, [markdown]);

  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});

  // 拉 missing 的 id。每个 id 调 inbox.read 拿 data URL（InboxStore.read
  // 内部把字节读成 base64 data: URL 返回，渲染端永不接触绝对路径）。
  // 顺序无关：每张图自己一个 await，全部完成后合并 setState。并发请求
  // 用单次 Promise.all 合并，避免 race 把较早的 setState 覆盖。
  useEffect(() => {
    const pending = attachmentIds.filter((id) => !(id in dataUrls));
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const fetched = await Promise.all(
        pending.map(async (id) => {
          const r = await window.todoList.inbox.read({ id });
          return { id, dataUrl: r.ok ? r.data.dataUrl : null };
        }),
      );
      if (cancelled) return;
      const updates: Record<string, string> = {};
      let hadAny = false;
      for (const { id, dataUrl } of fetched) {
        if (dataUrl !== null) { updates[id] = dataUrl; hadAny = true; }
      }
      if (hadAny) setDataUrls((prev) => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentIds]);

  // 稳定引用 —— MarkdownText memo 把 pathImages 当依赖，每次新对象都会让
  // 它整文档重渲一次。dataUrls 是 state 引用，但 pathImages 本身用
  // useMemo 跟它绑定，整体变化粒度 = dataUrls 变化（一个 id 落盘完成后）。
  const pathImages = useMemo<MarkdownPathImages>(() => ({
    resolve(value: string): string | undefined {
      const m = /^attachment:\/\/([A-Za-z0-9_-]+)$/.exec(value);
      if (!m) return undefined;
      return dataUrls[m[1]!];
    },
  }), [dataUrls]);

  if (empty) {
    return <div className="md-preview md-preview--empty">（无内容可预览）</div>;
  }
  return (
    <div className="md-preview">
      <MarkdownText text={markdown} labels={PREVIEW_LABELS} pathImages={pathImages} />
    </div>
  );
};

/** Compact local timestamp used as the alt text for pasted images
 *  (`pasted-YYYYMMDD-HHMMSS-i`). Pure formatting — no locale dependence on
 *  toLocaleString because we want a stable ASCII alt regardless of system
 *  language, so the markdown stays diff-friendly and the test suite is
 *  deterministic. */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** Encode a Blob into a base64 data: URL. Mirrors the helper in
//  Composer.tsx — kept local here to avoid a cross-component coupling for a
//  five-line FileReader dance. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}