// Render markdown for chat / preview. Reuses marked + dompurify (already used by
// MarkdownEditor's preview). Sync parse so streaming re-renders stay cheap; the
// result is memoised on the input string so token-by-token updates don't redo
// work for unchanged text. Output is sanitised before injection.

import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true, async: false });

export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const html = useMemo(() => {
    if (!text) return '';
    const raw = marked.parse(text) as string;
    return DOMPurify.sanitize(raw, {
      // Allow only inline/block semantics a chat bubble needs; strip scripts,
      // iframes, event handlers, styles. marked outputs standard HTML tags.
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'img', 'input',
      ],
      ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'class', 'target', 'rel', 'type', 'checked', 'disabled'],
    });
  }, [text]);

  return <div className={className ?? 'markdown'} dangerouslySetInnerHTML={{ __html: html }} />;
};
