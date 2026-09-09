// AI Panel — thin webview shell that hosts the built
// @deepseek-ai/dsh-web-frontend dist (served via the dsh-web:// protocol
// registered in main/index.ts). All chat / tool-call / reasoning rendering
// comes from the official DSH web frontend — we never self-implement that UI
// in our renderer (per project directive).
//
// When the dist has not been built yet, the protocol handler serves a
// self-contained placeholder page so the panel still renders something
// useful (see DSH_WEB_PLACEHOLDER_HTML in main/index.ts). The AIPanel
// session/IPC machinery (dsh-runtime + ai-handlers) is fully wired and
// waiting for the iframe to connect.
//
// The iframe is mounted on demand: only when the panel is actually open
// (AIPanel.tsx conditionally renders AIPane), and only when the panel
// width is non-zero. A forced reload on visibilitychange (rather than
// re-mount) keeps the web frontend's own state — open thread, scroll
// position, input draft — across the user collapsing + reopening the panel.

import React, { useEffect, useRef } from 'react';

export const AIPane: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Reload the iframe whenever the panel becomes visible after being hidden.
  // The iframe is a sub-document inside the main BrowserWindow's webContents;
  // a hidden iframe keeps running but can fall behind on Cordis plugin state
  // if the user keeps the panel collapsed for a long time. A reload on
  // visibility-recover is the simplest way to keep it fresh.
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return;
      const el = iframeRef.current;
      if (!el) return;
      // Only reload if the iframe has been mounted for a while — guards
      // against an infinite reload loop if visibilitychange fires while
      // the document is still mounting.
      el.src = el.src;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className="ai-pane__dsh-web"
      src="dsh-web://index.html"
      title="AI 助手"
      // The dsh-web:// scheme is registered as a privileged scheme with
      // secure + corsEnabled, so the iframe is treated as a first-party
      // secure context. The web frontend's transport then talks to our
      // main process via window.parent / custom events bridged through the
      // host page (see ai-bridge.ts).
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    />
  );
};