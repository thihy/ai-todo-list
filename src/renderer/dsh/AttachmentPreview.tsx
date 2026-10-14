import { createElement, useState } from 'react';

/** Only the host's indexed composer inbox can be served by this URL. */
export function composerImageUrl(path: string): string {
  const filename = path.split(/[/\\]/).pop() ?? '';
  return `attachment://composer/${encodeURIComponent(filename)}`;
}

export function AttachmentPreview({ path, mime, name }: { path: string; mime: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!mime.startsWith('image/') || failed) return null;
  return createElement('img', { className: 'ai-attachment-preview', src: composerImageUrl(path), alt: name,
    loading: 'lazy', onError: () => setFailed(true) });
}
