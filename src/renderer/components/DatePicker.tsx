// Date picker — text input accepts ISO date or relative strings; emits ms epoch.

import React, { useState } from 'react';

export const DatePicker: React.FC<{
  value: number | null;
  onChange: (ms: number | null) => void;
}> = ({ value, onChange }) => {
  const [draft, setDraft] = useState(value ? toIsoDate(value) : '');

  return (
    <input
      type="date"
      aria-label="截止日期"
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (!next) {
          onChange(null);
        } else {
          onChange(new Date(next).getTime());
        }
      }}
      style={{ padding: 'var(--space-xs) var(--space-sm)' }}
    />
  );
};

function toIsoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}