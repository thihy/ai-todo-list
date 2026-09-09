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

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  IconStrike,
} from './icons';

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

export const MarkdownEditor: React.FC<{
  value: string;
  version: number | null;
  onSave: (markdown: string) => Promise<void>;
  saving: boolean;
  error: string | null;
}> = ({ value, version, onSave, saving, error }) => {
  const [md, setMd] = useState(value);
  const [view, setView] = useState<'write' | 'preview' | 'split'>('write');
  const dirty = md !== value && md !== '';

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Apply an edit and restore the textarea's selection on the next paint so
  // the user sees it where the transform put it.
  const applyEdit = useCallback((next: EditResult): void => {
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
        if (dirty) void onSave(md);
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

  return (
    <div className="md-editor">
      <div className="md-editor__bar">
        <div className="md-editor__tabs">
          <button type="button" className={`md-editor__tab${view === 'write' ? ' is-active' : ''}`} onClick={() => setView('write')} aria-pressed={view === 'write'}>编辑</button>
          <button type="button" className={`md-editor__tab${view === 'preview' ? ' is-active' : ''}`} onClick={() => setView('preview')} aria-pressed={view === 'preview'}>预览</button>
          <button type="button" className={`md-editor__tab${view === 'split' ? ' is-active' : ''}`} onClick={() => setView('split')} aria-pressed={view === 'split'}>分屏</button>
        </div>
        <span className="md-editor__spacer" />
        {saving && <span className="md-editor__status">保存中…</span>}
        {error && <span className="md-editor__status md-editor__status--error">{error}</span>}
        <button
          type="button"
          className={`md-editor__save${dirty ? ' is-dirty' : ''}`}
          onClick={() => void onSave(md)}
          disabled={!dirty || saving}
        >
          {dirty ? '保存' : '已保存'}
        </button>
      </div>

      {/* Format toolbar — only meaningful in write/split. Hidden in pure
          preview to avoid noise. Each button is a no-op (just a refocus)
          when the textarea isn't mounted yet, so clicks are safe. */}
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
          <span className="md-editor__tb-sep" aria-hidden="true" />
          <span className="md-editor__tb-hint" title="Ctrl/Cmd+B 粗体 · Ctrl/Cmd+I 斜体 · Ctrl/Cmd+K 链接 · Tab 缩进 · Shift+Tab 减少缩进 · 回车续行">
            快捷键
          </span>
        </div>
      )}

      <div className={`md-editor__body md-editor__body--${view}`}>
        {view !== 'preview' && (
          <textarea
            ref={textareaRef}
            className="md-editor__textarea"
            aria-label="Markdown 正文"
            value={md}
            onChange={(e) => setMd(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            spellCheck={false}
          />
        )}
        {view !== 'write' && (
          <Preview markdown={md} />
        )}
      </div>
    </div>
  );
};

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

const Preview: React.FC<{ markdown: string }> = ({ markdown }) => {
  const [html, setHtml] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);

  // Render markdown → sanitised HTML. Mermaid blocks become
  // <div class="mermaid"> placeholders (the custom code renderer); they're
  // transformed to SVG in the effect below, AFTER the HTML is in the DOM.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([
        import('marked'),
        import('dompurify'),
      ]);
      const renderer = new marked.Renderer();
      const origCode = renderer.code.bind(renderer);
      renderer.code = (arg: unknown): string => {
        // marked v16 calls code({ text, lang, escaped }). Support both the
        // object form (v6+) and the legacy positional form.
        const o = arg as { text?: string; lang?: string; escaped?: boolean };
        if (o.lang === 'mermaid') {
          // Mermaid reads the raw diagram text from the element's textContent;
          // keep it unescaped so entities like &gt; survive verbatim.
          return `<div class="mermaid">${o.text ?? ''}</div>`;
        }
        return origCode(arg as never);
      };
      marked.use({ gfm: true, breaks: false, renderer });
      const raw = await marked.parse(markdown);
      const clean = DOMPurify.sanitize(raw as string, {
        // Mermaid's rendered SVG uses classes/attributes DOMPurify would
        // strip by default; but we only sanitise the marked HTML here —
        // mermaid.run injects SVG afterwards (post-sanitisation), so a plain
        // config is safe and the diagram SVG is never passed through it.
        ADD_ATTR: ['target'],
      } as Record<string, unknown>);
      if (!cancelled) setHtml(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  // After the HTML is mounted, find .mermaid placeholders and render them.
  // Dynamic-imported so note docs without diagrams don't load the library.
  useEffect(() => {
    if (!hostRef.current) return;
    const nodes = hostRef.current.querySelectorAll<HTMLElement>('.mermaid');
    if (nodes.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
        // Re-init each placeholder (mermaid mutates them in place) and render.
        const targets = Array.from(nodes) as HTMLElement[];
        for (const n of targets) {
          // mermaid expects the diagram source as the element's textContent;
          // the placeholder already holds it. Clear any prior render id.
          n.removeAttribute('data-processed');
        }
        await mermaid.run({ nodes: targets });
      } catch {
        // If a diagram is invalid, leave the raw source visible so the user
        // sees the error rather than a blank box.
        if (!cancelled) {
          for (const n of Array.from(nodes)) n.classList.add('mermaid--error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <div
      ref={hostRef}
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};