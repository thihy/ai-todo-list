// Markdown renderer for chat bubbles, tool outputs, and inline previews.
// Thin wrapper around `MarkdownText` from
// @deepseek-ai/dsh-client-ui-primitives — the primitives package's GFM +
// KaTeX + Shiki renderer (handles streaming via its incremental parser).
//
// We keep this thin file because (a) several call sites pass `className`
// for sizing/positioning (chat bubble padding vs inline preview), and
// (b) the `labels` prop must be reference-stable per locale (per the
// MarkdownText contract — a new identity discards the streaming cache
// mid-message), so we hoist the labels object out of render scope.

import React, { useMemo } from 'react';
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';

// Reference-stable labels — same identity for every render in the same
// session, so the streaming cache survives each token update.
const LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
};

export const Markdown: React.FC<{ text: string; className?: string; streaming?: boolean }> = ({
  text,
  className,
  streaming,
}) => {
  // Memoize the wrapper element so React reconciles instead of remounting
  // the MarkdownText subtree when only `text` changes (which is the entire
  // point of using a memoized Markdown component during streaming).
  const wrapperStyle = useMemo<React.CSSProperties | undefined>(() => undefined, []);
  return (
    <div className={className ?? 'markdown'} style={wrapperStyle}>
      <MarkdownText text={text} streaming={streaming} labels={LABELS} />
    </div>
  );
};
