// Capture window entry — small always-on-top composer for Ctrl+Shift+T.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const Capture: React.FC = () => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const v = text.trim();
    if (!v) {
      window.close();
      return;
    }
    setSaving(true);
    const res = await window.thihy.capture.submit({ title: v.split('\n')[0].slice(0, 200), markdown: v });
    setSaving(false);
    if (!res.ok) {
      setErr(res.message ?? '提交失败');
      return;
    }
    window.close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Escape') {
        window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      style={{
        height: '100vh',
        padding: 12,
        background: 'var(--bg-surface)',
        color: 'var(--fg-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 'var(--font-xs)',
          color: 'var(--fg-muted)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>快速捕获 · Ctrl+Enter 提交 · Esc 关闭</span>
        <span>{saving ? '保存中…' : ''}</span>
      </div>
      <textarea
        autoFocus
        aria-label="捕获内容"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="记一笔 TODO…（支持多行，写在第一行的是标题）"
        style={{
          flex: 1,
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--font-md)',
          lineHeight: 1.5,
          resize: 'none',
        }}
      />
      {err && <div style={{ color: 'var(--accent-danger)', fontSize: 'var(--font-xs)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => window.close()}
          style={{
            padding: '4px 12px',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--fg-secondary)',
          }}
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          style={{
            padding: '4px 16px',
            background: 'var(--accent-primary)',
            color: 'var(--fg-on-accent)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) createRoot(container).render(<Capture />);