// Priority picker — buttons + dropdown for free text.

import React from 'react';
import type { Priority } from '../../shared/todo-types';

const options: Array<{ value: Priority; label: string; color: string }> = [
  { value: 'high', label: '高', color: 'var(--accent-danger)' },
  { value: 'medium', label: '中', color: 'var(--accent-warn)' },
  { value: 'low', label: '低', color: 'var(--accent-info)' },
  { value: 'none', label: '—', color: 'var(--fg-muted)' },
];

export const PriorityPicker: React.FC<{
  value: Priority;
  onChange: (v: Priority) => void;
}> = ({ value, onChange }) => (
  <div role="radiogroup" aria-label="优先级" style={{ display: 'inline-flex', gap: 4 }}>
    {options.map((o) => (
      <button
        type="button"
        key={o.value}
        role="radio"
        aria-checked={value === o.value}
        onClick={() => onChange(o.value)}
        style={{
          padding: '2px var(--space-sm)',
          borderRadius: 'var(--radius-pill)',
          border: `1px solid ${o.color}`,
          color: o.color,
          background: value === o.value ? o.color : 'transparent',
          fontWeight: value === o.value ? 600 : 400,
        }}
      >
        {o.label}
      </button>
    ))}
  </div>
);