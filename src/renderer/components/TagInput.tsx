// Tag input — chip entry, comma/Enter to commit, Backspace removes.

import React, { useState } from 'react';

export const TagInput: React.FC<{
  value: string[];
  onChange: (tags: string[]) => void;
}> = ({ value, onChange }) => {
  const [draft, setDraft] = useState('');
  const commit = (): void => {
    const tag = draft.trim().replace(/^#/, '');
    if (!tag) return;
    if (value.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...value, tag]);
    setDraft('');
  };
  const remove = (tag: string): void => {
    onChange(value.filter((t) => t !== tag));
  };
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px var(--space-sm)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-input)',
      }}
    >
      {value.map((tag) => (
        <span
          key={tag}
          style={{
            background: 'var(--bg-surface-elev)',
            color: 'var(--accent-info)',
            borderRadius: 'var(--radius-pill)',
            padding: '0 var(--space-sm)',
            fontSize: 'var(--font-xs)',
          }}
        >
          #{tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            aria-label={`移除标签 ${tag}`}
            style={{ marginLeft: 4, color: 'var(--fg-muted)' }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="添加标签"
        placeholder="+ 标签"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !draft && value.length) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={commit}
        style={{
          border: 0,
          background: 'transparent',
          padding: '2px var(--space-xs)',
          width: 100,
        }}
      />
    </div>
  );
};