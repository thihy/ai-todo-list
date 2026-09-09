// InlineTitle — the task title surface in the detail header.
//
// Two modes, no permanent input:
//   - read: a large selectable <h1>. Text is selectable so the user can copy it
//     freely. A faint copy button appears on hover for one-click copy. Single
//     click does NOT enter edit mode (avoids the old bug where every click into
//     the field staged a draft and a stray blur committed a no-op write).
//   - edit: entered on double-click (or the copy button's sibling "edit"
//     affordance). An <input> replaces the heading; Enter or blur commits,
//     Escape cancels. The input auto-selects on entry so a typed replacement
//     just works.
//
// The parent owns the committed value + draft sync (via `value`). We keep an
// internal draft only while editing so an Escape restores the canonical value
// without a round-trip.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const InlineTitle: React.FC<{
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
}> = ({ value, onCommit, placeholder }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the internal draft honest when the canonical value changes externally
  // (e.g. another surface edited the title, or the todo was reloaded).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-focus + select on entry so typing immediately replaces the old title.
  useLayoutEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const enter = (): void => {
    setDraft(value);
    setEditing(true);
  };

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onCommit(next);
  };

  const cancel = (): void => {
    setDraft(value);
    setEditing(false);
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Clipboard can be unavailable in some Electron contexts; the text is
      // still selectable as a fallback, so fail silently.
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="editor-pane__title-input"
        aria-label="TODO 标题"
        value={draft}
        placeholder={placeholder ?? '标题'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
    );
  }

  return (
    <div className="editor-pane__title-row">
      <h1
        className="editor-pane__title"
        tabIndex={0}
        onDoubleClick={enter}
        title="双击编辑标题"
      >
        {value || placeholder || '标题'}
      </h1>
      <button
        type="button"
        className="editor-pane__title-copy"
        aria-label="复制标题"
        title="复制标题"
        onClick={copy}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1.5" y="1.5" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="var(--bg-surface)" />
        </svg>
      </button>
    </div>
  );
};
