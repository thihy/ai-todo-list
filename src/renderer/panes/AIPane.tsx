// AI Panel — host placeholder for the WebContentsView that renders the
// official @deepseek-ai/dsh-web-frontend (consumed via the dsh-web://
// protocol registered in main/index.ts). All chat / tool-call / reasoning
// rendering comes from the official DSH web frontend — we never self-
// implement that UI in our renderer (per project directive).
//
// Architecture (vs the previous iframe approach):
// - We render a plain <div ref={hostRef} /> filling the AIPane container.
// - A ResizeObserver measures the div and pushes `{ bounds, visible: true }`
//   to main via `aipane.layout`. Main maintains a single WebContentsView
//   (no iframe sandbox; the view is a child of the BrowserWindow's
//   contentView, sharing the renderer's main loop).
// - On unmount we push `visible: false` so main detaches the view.
// - The WebContentsView is created lazily on first show and kept alive
//   across show/hide — the DSH web frontend's open thread, scroll position,
//   and input draft all survive a panel toggle.

import React, { useEffect, useRef } from 'react';

interface HostBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measureBounds(el: HTMLElement): HostBounds {
  // The renderer is the BrowserWindow's contentView (no separate webContents),
  // so getBoundingClientRect returns contentView-local coordinates — the same
  // coordinate system WebContentsView.setBounds() expects. Round to integers
  // because Electron's setBounds truncates anyway, and equality checks then
  // succeed without sub-pixel drift.
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.max(0, Math.round(r.width)),
    height: Math.max(0, Math.round(r.height)),
  };
}

export const AIPane: React.FC = () => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    // Push initial bounds immediately so main mounts the WebContentsView
    // without waiting for the first ResizeObserver tick (which fires on the
    // next animation frame and would leave a one-frame gap of empty pane).
    void window.thihy.aipane.layout({ bounds: measureBounds(el), visible: true });

    const ro = new ResizeObserver(() => {
      const el2 = hostRef.current;
      if (!el2) return;
      void window.thihy.aipane.layout({ bounds: measureBounds(el2), visible: true });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      // Detach the WebContentsView on unmount. Pass zero bounds so any
      // stale observers reading bounds during teardown see a hidden view.
      void window.thihy.aipane.layout({ bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="ai-pane__host"
      // The WebContentsView is opaque and paints over everything inside
      // these bounds; this div exists only so the renderer can measure
      // its layout and report it to main.
      aria-hidden="true"
    />
  );
};