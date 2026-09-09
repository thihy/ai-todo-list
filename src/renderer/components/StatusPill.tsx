// StatusPill — the inline status affordance for the detail header. A compact
// pill that shows the StatusGlyph + label and cycles to the next status on
// click (same `nextStatus` cycle as the list row, so the two surfaces feel
// like one control at different zoom levels). Replaces the old native
// `<select>` in TodoEditorPane, which was visually loud and demanded a
// dropdown open just to nudge the lifecycle forward.

import React from 'react';
import type { TodoStatus } from '../../shared/todo-types';
import { STATUS_LABEL, nextStatus, StatusGlyph } from './StatusGlyph';

export const StatusPill: React.FC<{
  status: TodoStatus;
  onCycle: (next: TodoStatus) => void;
}> = ({ status, onCycle }) => {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <button
      type="button"
      className={`editor-pane__status-pill is-${status}`}
      aria-label={`状态：${label}，点击切换`}
      title={`状态：${label}（点击切换）`}
      onClick={() => onCycle(nextStatus(status))}
    >
      <StatusGlyph status={status} />
      <span className="editor-pane__status-pill-label">{label}</span>
    </button>
  );
};
