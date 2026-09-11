// Resident AI panel — right side of the app, collapsible to a narrow rail.
// Open state is owned by App; this component renders the expanded chat
// (AIPane) or a vertical rail with an expand affordance. When open, the
// aside's width is the persisted pane width (so the user can resize the
// panel and it survives restart); when collapsed, it shrinks to the rail.

import React, { Suspense } from 'react';
import { IconSparkle } from '../components/icons';

// Lazy-load the AI pane: it drags in the whole vendored DSH render tree
// (ToolRow / ReasoningRow / card primitives + shiki + katex), none of which
// is needed until the user opens the panel. Keeps the cold-start entry chunk
// to just the todo-list shell + the collapsed rail.
const AIPane = React.lazy(() =>
  import('../panes/AIPane').then(m => ({ default: m.AIPane })),
);

export const AIPanel: React.FC<{ open: boolean; width: number; onToggle: () => void }> = ({ open, width, onToggle }) => {
  return (
    <aside
      className={`ai-panel${open ? ' is-open' : ''}`}
      aria-label="AI 助手"
      style={open ? { width } : undefined}
    >
      {open ? (
        <>
          <div className="ai-panel__grip" role="button" tabIndex={0} aria-label="收起 AI 助手" onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
            <ChevronRight />
          </div>
          <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载中…</div>}>
            <AIPane />
          </Suspense>
        </>
      ) : (
        <button
          type="button"
          className="ai-rail"
          onClick={onToggle}
          aria-label="展开 AI 助手"
          aria-expanded={false}
        >
          <span className="ai-rail__icon"><IconSparkle size={16} /></span>
          <span className="ai-rail__label">AI 助手</span>
          <ChevronLeft />
        </button>
      )}
    </aside>
  );
};

// The chevron points in the direction the panel edge moves when clicked:
// open grip ▶ (collapse toward the right edge), closed rail ◀ (expand
// leftward). The previous paths were swapped — ChevronRight drew a left-
// pointing ‹ and vice versa — so both affordances read backwards.
const ChevronRight: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ChevronLeft: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
