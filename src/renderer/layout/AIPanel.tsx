// Resident AI panel — right side of the app, collapsible to a narrow rail.
// Open state is owned by App; this component renders the expanded chat
// (AIPane) or a vertical rail with an expand affordance.

import React from 'react';
import { AIPane } from '../panes/AIPane';

export const AIPanel: React.FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => {
  return (
    <aside
      className={`ai-panel${open ? ' is-open' : ''}`}
      aria-label="AI 助手"
      style={{ width: open ? undefined : undefined }}
    >
      {open ? (
        <>
          <div className="ai-panel__grip" role="button" tabIndex={0} aria-label="收起 AI 助手" onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
            <ChevronRight />
          </div>
          <AIPane onCollapse={onToggle} />
        </>
      ) : (
        <button
          type="button"
          className="ai-rail"
          onClick={onToggle}
          aria-label="展开 AI 助手"
          aria-expanded={false}
        >
          <span className="ai-rail__icon" aria-hidden="true">✦</span>
          <span className="ai-rail__label">AI 助手</span>
          <ChevronLeft />
        </button>
      )}
    </aside>
  );
};

const ChevronRight: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ChevronLeft: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
