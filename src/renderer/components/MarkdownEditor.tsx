// Markdown editor with write / preview / split views. The source editor is a
// plain textarea (CodeMirror was never wired up; the comment lied). The
// preview renders GitHub-Flavoured Markdown (tables, task lists, strike-
// through) via `marked`, sanitised with DOMPurify, plus Mermaid diagrams:
// ```mermaid blocks are turned into <div class="mermaid"> placeholders by a
// custom marked renderer, then `mermaid.run` replaces them with live SVG
// after sanitisation. Mermaid is dynamically imported only when a diagram is
// present, so note docs without diagrams pay nothing.

import React, { useEffect, useRef, useState } from 'react';

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

  // When the backend version changes (data-bus refresh after an external
  // edit) re-apply the canonical value — unless the user is mid-edit (dirty).
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
      <div className={`md-editor__body md-editor__body--${view}`}>
        {view !== 'preview' && (
          <textarea
            className="md-editor__textarea"
            aria-label="Markdown 正文"
            value={md}
            onChange={(e) => setMd(e.target.value)}
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
      });
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
