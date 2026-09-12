// Resident AI panel — right side of the app, collapsible to a narrow rail.
// Open state is owned by App; this component renders the expanded chat
// (AIPane) or a vertical rail with an expand affordance. When open, the
// aside's width is the persisted pane width (so the user can resize the
// panel and it survives restart); when collapsed, it shrinks to the rail.

import React, { Suspense } from 'react';
import { IconChevronLeft, IconSparkle } from '../components/icons';
import type { ExternalAiSubmitDetail } from '../components/Composer';

// Lazy-load the AI pane: it drags in the whole vendored DSH render tree
// (ToolRow / ReasoningRow / card primitives + shiki + katex), none of which
// is needed until the user opens the panel. Keeps the cold-start entry chunk
// to just the todo-list shell + the collapsed rail.
const AIPane = React.lazy(() =>
  import('../panes/AIPane').then(m => ({ default: m.AIPane })),
);

export const AIPanel: React.FC<{
  open: boolean;
  width: number;
  onToggle: () => void;
  externalSubmit?: ExternalAiSubmitDetail | null;
  onExternalSubmitConsumed?: () => void;
}> = ({ open, width, onToggle, externalSubmit, onExternalSubmitConsumed }) => {
  return (
    <aside
      className={`ai-panel${open ? ' is-open' : ''}`}
      aria-label="AI 助手"
      // Open: persisted pane width. Collapsed: shrink to the rail width so
      // the rail hugs the right edge — previously the aside kept the 384px
      // open default and the 40px rail floated at its left with a gap.
      style={open ? { width } : { width: 'var(--ai-rail-w)' }}
    >
      {open ? (
        // Collapse affordance lives INSIDE the AIPane header (right edge of
        // its title row) — not in a separate grip divider column. The user
        // perceives the IconCollapseBar as "part of the area" they're
        // looking at, not as a chrome handle on a separate strip. Passed
        // down as onCollapse so AIPane renders the button in its own
        // chrome rather than the parent layering an overlay on top.
        <Suspense fallback={<div className="ai-panel__loading" role="status" aria-live="polite">加载中…</div>}>
          <AIPane
            onCollapse={onToggle}
            externalSubmit={externalSubmit}
            onExternalSubmitConsumed={onExternalSubmitConsumed}
          />
        </Suspense>
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
          <IconChevronLeft size={14} />
        </button>
      )}
    </aside>
  );
};
