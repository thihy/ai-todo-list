// Drawing strip — horizontal thumbnails under the TODO header.

import React from 'react';
import type { DrawingMeta } from '../../shared/todo-types';

export const DrawingStrip: React.FC<{
  drawings: DrawingMeta[];
  onAdd: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => Promise<void>;
}> = ({ drawings, onAdd, onOpen }) => (
  <div
    aria-label="绘图"
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-sm)',
      marginTop: 'var(--space-md)',
      overflowX: 'auto',
    }}
  >
    {drawings.map((d) => (
      <button
        type="button"
        key={d.id}
        onClick={() => onOpen(d.id)}
        style={{
          width: 96,
          height: 64,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          padding: 0,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {d.thumbPath ? (
          <img src={d.thumbPath} alt={d.title ?? '绘图缩略图'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--font-xs)' }}>{d.title || '无标题'}</span>
        )}
      </button>
    ))}
    <button
      type="button"
      onClick={onAdd}
      style={{
        width: 96,
        height: 64,
        border: '1px dashed var(--border-default)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--fg-muted)',
        flexShrink: 0,
      }}
    >
      + 新绘图
    </button>
  </div>
);