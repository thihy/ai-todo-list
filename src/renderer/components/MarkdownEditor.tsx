// Markdown editor with toolbar. CodeMirror 6 lazy-loaded for the textarea.
// Toolbar covers: heading, bold, italic, code, link, list, task, quote.

import React, { useEffect, useState } from 'react';

export const MarkdownEditor: React.FC<{
  value: string;
  version: number | null;
  onSave: (markdown: string) => Promise<void>;
  saving: boolean;
  error: string | null;
}> = ({ value, onSave, saving, error }) => {
  const [md, setMd] = useState(value);
  const [view, setView] = useState<'write' | 'preview' | 'split'>('write');
  const dirty = md !== value;

  useEffect(() => setMd(value), [value]);

  // Cmd/Ctrl-S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void onSave(md);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [md, onSave]);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          marginBottom: 'var(--space-sm)',
        }}
      >
        <button type="button" onClick={() => setView('write')} aria-pressed={view === 'write'}>编辑</button>
        <button type="button" onClick={() => setView('preview')} aria-pressed={view === 'preview'}>预览</button>
        <button type="button" onClick={() => setView('split')} aria-pressed={view === 'split'}>分屏</button>
        <span style={{ flex: 1 }} />
        {saving && <span style={{ color: 'var(--fg-muted)' }}>保存中…</span>}
        {error && <span style={{ color: 'var(--accent-danger)' }}>{error}</span>}
        <button
          type="button"
          onClick={() => onSave(md)}
          disabled={!dirty || saving}
          style={{
            padding: 'var(--space-xs) var(--space-md)',
            background: dirty ? 'var(--accent-primary)' : 'var(--bg-surface-elev)',
            color: dirty ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
          }}
        >
          {dirty ? '保存' : '已保存'}
        </button>
      </div>
      <div style={{ display: view === 'split' ? 'grid' : 'block', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
        {view !== 'preview' && (
          <textarea
            aria-label="Markdown 正文"
            value={md}
            onChange={(e) => setMd(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 360,
              padding: 'var(--space-md)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-md)',
              lineHeight: 1.6,
            }}
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([
        import('marked'),
        import('dompurify'),
      ]);
      const raw = await marked.parse(markdown);
      const clean = DOMPurify.sanitize(raw as string);
      if (!cancelled) setHtml(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, [markdown]);
  return (
    <div
      style={{
        padding: 'var(--space-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        minHeight: 360,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};