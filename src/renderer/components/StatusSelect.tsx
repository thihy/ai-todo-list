// StatusSelect — a click-to-open status picker. Replaces the old "click to
// cycle" behavior (nextStatus) in both the detail header and the list row,
// which made off-track states (已取消 / 阻塞中) hard to reach and felt like
// guessing. Opens a popover listing all five statuses with their glyph +
// label; the current one is highlighted. Picking one calls onChange and
// closes. Two surface variants share one control: a labeled pill (detail)
// and an icon-only compact trigger (list row).
//
// The menu is rendered through createPortal into document.body with
// position:fixed, instead of being a child of the trigger (position:absolute).
// Reason: the task row sets overflow:hidden on .task-row so the meta-line
// pills clip cleanly when the row gets narrow — that same overflow context
// also clips the popover when it extends below the row, leaving the user with
// only the top sliver of the menu visible. Portalling escapes that ancestor
// chain entirely. The icon variant right-aligns the menu so it stays inside
// the (narrow) sidebar at the left edge; the pill variant left-aligns.
//
// Vertical placement is a TWO-PASS layout effect (see below). A trigger in the
// bottom rows of the task list — e.g. the last visible row, where the viewport
// has only ~20px below it but ~170px above — must open UPWARD, or the 168px
// menu hangs off the bottom of the window. Deciding that requires the menu's
// real height, which is only knowable once it is in the DOM: pass 1 anchors it
// so it mounts, pass 2 measures and corrects. Both are layout effects, so the
// flip is resolved before paint and never shows as a jump.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TODO_STATUSES, type TodoStatus } from '../../shared/todo-types';
import { STATUS_LABEL, StatusGlyph } from './StatusGlyph';
import { IconClose } from './icons';

interface MenuPos {
  // Viewport coords the CSS uses to anchor the menu. `left` is set for the
  // pill trigger (anchor by left edge) and `right` for the icon trigger
  // (anchor by right edge so the menu grows leftward into the sidebar).
  top: number;
  left?: number;
  right?: number;
}

export const StatusSelect: React.FC<{
  status: TodoStatus;
  onChange: (next: TodoStatus) => void;
  variant?: 'pill' | 'icon';
}> = ({ status, onChange, variant = 'pill' }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Stable wrapper around the trigger. Used only for the "outside click"
  // check; the menu itself lives in document.body so it isn't a DOM sibling
  // of the trigger anymore.
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [flipUp, setFlipUp] = useState(false);
  const label = STATUS_LABEL[status] ?? status;

  // Recompute the menu position from the trigger's current viewport rect.
  // Called once the menu is mounted (see the measuring pass below), on
  // scroll (any ancestor), and on resize. Doesn't run during render.
  const recompute = (): void => {
    const t = triggerRef.current;
    if (!t) return;
    const rect = t.getBoundingClientRect();
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const gap = 4;
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    // Flip when the menu genuinely wouldn't fit below AND there's more room
    // above than below — the latter avoids flipping into a cramped space
    // just because the trigger is near the bottom. `menuH` is 0 on the
    // pre-measure pass (menu not mounted yet), which anchors below; the
    // post-mount pass corrects it.
    const flip = menuH > 0 && spaceBelow < menuH && spaceAbove > spaceBelow;
    setFlipUp(flip);
    const preferredTop = flip ? rect.top - menuH - gap : rect.bottom + gap;
    // Clamp into the viewport so the menu never leaves the window on
    // either side. When even the preferred side can't fit (a very short
    // window with a tall menu), this pins it to the top edge instead of
    // letting it run off-screen.
    const top = Math.min(Math.max(preferredTop, gap), Math.max(gap, vh - menuH - gap));
    const next: MenuPos =
      variant === 'icon'
        ? { top, right: window.innerWidth - rect.right }
        : { top, left: rect.left };
    // Keep the previous object identity when nothing moved: the measuring
    // layout effect depends on `pos`, so a fresh object on every pass
    // would re-trigger it forever. Returning `prev` also lets React bail
    // out of the re-render entirely.
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.right === next.right
        ? prev
        : next,
    );
  };

  // Pass 1 (on open): anchor the menu below the trigger so it EXISTS in
  // the DOM. Positioning from the trigger rect — rather than leaving it
  // at the stylesheet default — means even this pre-measure frame lands
  // in the right place, so there is no visible jump while the height is
  // still unknown.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setFlipUp(false);
      return;
    }
    const t = triggerRef.current;
    if (!t) return;
    const rect = t.getBoundingClientRect();
    setPos(
      variant === 'icon'
        ? { top: rect.bottom + 4, right: window.innerWidth - rect.right }
        : { top: rect.bottom + 4, left: rect.left },
    );
  }, [open, variant]);

  // Pass 2 (the menu is mounted now, so offsetHeight is real): decide the
  // flip and correct the position. Depends on `pos` so it fires right
  // after pass 1 renders the menu into the DOM. Both passes are layout
  // effects, so all of this lands before the browser paints — the user
  // only ever sees the final, corrected position.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    recompute();
    const onScroll = (): void => { recompute(); };
    const onResize = (): void => { recompute(); };
    // capture:true so we catch scrolls on ANY ancestor, not just window —
    // the task list scrolls inside .task-list__body, not the document.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant, pos]);

  // Close on outside click / Escape. The menu is portalled out of the trigger
  // tree, so the "outside" check has to consider BOTH the trigger wrapper
  // AND the menu ref — clicking either keeps it open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (rootRef.current?.contains(tgt)) return;
      if (menuRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stop = (e: React.SyntheticEvent): void => {
    e.stopPropagation();
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={
        variant === 'pill'
          ? `editor-pane__status-pill is-${status}`
          : `task-row__status is-${status}`
      }
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={variant === 'pill' ? `状态：${label}，点击选择` : undefined}
      title={variant === 'pill' ? `状态：${label}` : `状态：${label}（点击选择）`}
      onClick={(e) => {
        stop(e);
        setOpen((v) => !v);
      }}
    >
      <StatusGlyph status={status} />
      {variant === 'pill' && (
        <span className="editor-pane__status-pill-label">{label}</span>
      )}
    </button>
  );

  return (
    <span className={`status-select status-select--${variant}`} ref={rootRef}>
      {trigger}
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className={`status-select__menu status-select__menu--fixed${flipUp ? ' is-flipped' : ''}${variant === 'icon' ? ' is-icon' : ' is-pill'}`}
          role="listbox"
          aria-label="选择状态"
          style={
            variant === 'icon'
              ? { top: pos.top, right: pos.right, left: 'auto' as const }
              : { top: pos.top, left: pos.left }
          }
        >
          {TODO_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={s === status}
              className={`status-select__option${s === status ? ' is-active' : ''}`}
              onClick={(e) => {
                stop(e);
                onChange(s);
                setOpen(false);
              }}
            >
              <StatusGlyph status={s} />
              <span className="status-select__option-label">{STATUS_LABEL[s]}</span>
              {s === status && <IconClose size={12} className="status-select__option-check" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
};

// IconClose is used as a "current selection" check mark; re-exported to keep
// the import above from being tree-shaken in some builds.
export { IconClose };