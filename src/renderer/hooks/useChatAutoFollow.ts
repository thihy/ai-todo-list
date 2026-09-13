// Auto-follow behaviour for a chat-style scroll container.
//
// "Following" means: when new content extends the bottom, we keep the viewport
// pinned to the bottom so the user sees the latest message (typical UX for
// streaming chat). The user can opt out by scrolling up — that's the whole
// reason this hook exists instead of `useEffect(() => el.scrollTop = ...)`
// in the host. Once they scroll back near the bottom we silently resume.
//
// Reference: @deepseek-ai/dsh-client-ui-chat ChatView atBottomRef + 25px
// threshold + observedTopRef pattern. We deliberately do NOT pull in that
// module's pagination / chat store — those are out of scope here. This hook
// only handles "sticky-to-bottom" semantics for one container.

import { useCallback, useEffect, useRef, useState } from 'react';

const AT_BOTTOM_THRESHOLD = 25; // px — DSH ChatView's value
const ARROW_UP = 'ArrowUp';
const ARROW_DOWN = 'ArrowDown';
const PAGE_UP = 'PageUp';
const PAGE_DOWN = 'PageDown';
const HOME = 'Home';
const END = 'End';
const SPACE = ' ';

export interface UseChatAutoFollowOpts {
  /** Current conversation id. When it changes we reset the follow state and
   *  cancel any in-flight frames. Background conversations whose id doesn't
   *  match `currentConversationId` must not influence this container. */
  currentConversationId: string | null;
  /** The scrollable viewport. */
  scrollRef: React.RefObject<HTMLElement>;
  /** The inner content wrapper. ResizeObserver watches it so text growth /
   *  image load / reasoning-row expansion all extend the scroll viewport. */
  contentRef: React.RefObject<HTMLElement>;
  /** Whether the host has finished loading this conversation's history. The
   *  hook waits for `true` before doing the first bottom-pinned scroll,
   *  otherwise we'd snap to a partial height and immediately jump again
   *  when more turns arrive. */
  historyLoaded: boolean;
}

export interface UseChatAutoFollowResult {
  /** Whether to show the "jump to latest" affordance. */
  showJumpToLatest: boolean;
  /** Programmatic jump-to-bottom: restores follow state and hides the button. */
  jumpToLatest: () => void;
  /** Called by the host AFTER a new user message has been admitted into the
   *  target conversation's DOM (i.e. setState has flushed and React has
   *  committed). We schedule a follow on the next frame so the scroll lands
   *  after layout. The id is checked at frame time — if the user switched
   *  conversations meanwhile, the frame is a no-op. */
  requestFollow: (conversationId: string) => void;
}

interface FollowState {
  following: boolean;
}

export function useChatAutoFollow(opts: UseChatAutoFollowOpts): UseChatAutoFollowResult {
  const { currentConversationId, scrollRef, contentRef, historyLoaded } = opts;

  // `followingRef` mirrors "is the user currently sticky-to-bottom" without
  // forcing re-renders. The visible UI (jump-to-latest button) reads from
  // `showJumpToLatest` state, which lags the ref by one frame to keep DOM
  // measurements cheap.
  const followingRef = useRef<FollowState>({ following: true });

  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Single rAF handle shared by content growth / resize / requestFollow.
  // Coalesces bursts (e.g. a chunk of streaming tokens) into one scroll.
  const pendingFrameRef = useRef<number | null>(null);

  // When the hook (not the user) writes scrollTop, the browser fires a
  // scroll event. We suppress that single event by recording the value we
  // just wrote; the scroll handler reads it and skips the "user scrolled"
  // branch if the observed top matches our written value.
  const lastProgrammaticScrollTopRef = useRef<number | null>(null);

  // Active conversation snapshot — read inside the rAF to decide whether
  // a queued scroll still applies. Captured at frame time, not at schedule.
  const activeConvIdRef = useRef<string | null>(currentConversationId);
  activeConvIdRef.current = currentConversationId;

  // --- helpers -----------------------------------------------------------

  const cancelPendingFrame = useCallback((): void => {
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  }, []);

  /** Distance (px) from the bottom of the scroll viewport. 0 = exactly at
   *  bottom. Uses `Math.max` so a content that's shorter than the viewport
   *  (no scrolling possible) returns 0 instead of negative numbers. */
  const distanceFromBottom = useCallback((el: HTMLElement): number => {
    return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  }, []);

  /** Instant scroll-to-bottom. Records the written scrollTop so the scroll
   *  event fired by the browser is recognised as programmatic. We use
   *  `behavior: 'auto'` (instant) deliberately — smooth-scroll on every
   *  streaming token makes text feel like it's trailing the cursor. */
  const scrollToBottom = useCallback((el: HTMLElement): void => {
    const target = el.scrollHeight - el.clientHeight;
    lastProgrammaticScrollTopRef.current = target;
    el.scrollTop = target;
  }, []);

  /** Schedules a follow-scroll on the next frame if the conversation is
   *  still active and the user is still following. Coalesces bursts — the
   *  second call within the same frame just re-arms to the same handle. */
  const scheduleFollowFrame = useCallback((): void => {
    if (pendingFrameRef.current !== null) return;
    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      const convId = activeConvIdRef.current;
      const el = scrollRef.current;
      if (!el) return;
      // Background conversations don't drive this container. If the active
      // id changed since scheduling, drop the scroll silently.
      if (convId !== activeConvIdRef.current) return;
      if (!followingRef.current.following) return;
      scrollToBottom(el);
      // Button reflects the post-scroll state: at-bottom ⇒ hide.
      setShowJumpToLatest(false);
    });
  }, [scrollRef, scrollToBottom]);

  // --- conversation-id lifecycle ----------------------------------------

  // Switching conversations resets everything: drop the frame, reset
  // following to true (a fresh conversation starts at the bottom), hide the
  // button. The actual first-paint scroll happens via the historyLoaded
  // effect below — we don't want to fight an unmounted/incomplete DOM.
  useEffect(() => {
    followingRef.current = { following: true };
    setShowJumpToLatest(false);
    cancelPendingFrame();
    lastProgrammaticScrollTopRef.current = null;
    // Intentionally no scrollTop write here — DOM may not be ready and the
    // historyLoaded-driven effect below handles the first bottom-pinned.
  }, [currentConversationId, cancelPendingFrame]);

  // First bottom-pinned scroll when a conversation's history finishes
  // loading (or right away if it was already loaded). The hook doesn't
  // observe `historyLoaded` as a scroll trigger beyond this initial pin;
  // subsequent growth is picked up by the ResizeObserver.
  useEffect(() => {
    if (!historyLoaded) return;
    const el = scrollRef.current;
    if (!el) return;
    // Two rAFs: first lets the new conversation's React subtree commit,
    // second lets the layout settle (especially with images / fonts).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (activeConvIdRef.current !== currentConversationId) return;
        const e = scrollRef.current;
        if (!e) return;
        scrollToBottom(e);
      });
    });
  }, [historyLoaded, currentConversationId, scrollRef, scrollToBottom]);

  // --- DOM listeners -----------------------------------------------------

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    /** Returns true when the most recent scroll event's delta was driven by
     *  user intent (wheel / touch / keyboard / scrollbar). We don't listen
     *  to those events directly — instead we compare against the snapshot
     *  we wrote ourselves: if scrollTop matches our programmatic value,
     *  it's not a user action. */
    const onScroll = (): void => {
      const programmatic = lastProgrammaticScrollTopRef.current;
      const top = el.scrollTop;
      // The browser can round the assignment; allow a 1px tolerance.
      if (programmatic !== null && Math.abs(top - programmatic) <= 1) {
        lastProgrammaticScrollTopRef.current = null;
        return;
      }
      const dist = distanceFromBottom(el);
      const atBottom = dist <= AT_BOTTOM_THRESHOLD;
      followingRef.current.following = atBottom;
      setShowJumpToLatest(!atBottom);
    };

    /** `wheel` events always come from the user (programmatic scrolls don't
     *  fire wheel). Up-scrolling pauses the follow; we also cancel any
     *  pending rAF the hook had scheduled so a half-rendered burst doesn't
     *  yank the user back. */
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0 && followingRef.current.following) {
        followingRef.current.following = false;
        setShowJumpToLatest(true);
        cancelPendingFrame();
      } else if (e.deltaY > 0) {
        // Scrolling down — let onScroll decide whether we're back at bottom.
        // No state change here; onScroll handles it.
      }
    };

    /** Touch-drag on mobile: same contract as wheel — upward drag pauses. */
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent): void => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (lastTouchY === null) return;
      const y = e.touches[0]?.clientY ?? null;
      if (y === null) return;
      // Touch clientY gets smaller as finger moves UP the screen.
      if (y > lastTouchY && followingRef.current.following) {
        followingRef.current.following = false;
        setShowJumpToLatest(true);
        cancelPendingFrame();
      }
      lastTouchY = y;
    };
    const onTouchEnd = (): void => { lastTouchY = null; };

    /** Keyboard scrolling: ONLY when the scroll container (or one of its
     *  non-interactive descendants) has focus. We don't attach to window
     *  because that would steal PageUp/PageDown from the textarea and from
     *  the in-card controls (reasoning-row expand toggle, etc.).
     *  We listen on the container itself and on the bubble descendants that
     *  capture focus when the user tabs through them. */
    const isContainerFocused = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      return target === el || el.contains(target);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isContainerFocused(e.target)) return;
      // Ignore key handling when the target is itself a focusable input-like
      // element (e.g. user tabbed into a button inside a reasoning row).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const isUpKey = e.key === ARROW_UP || e.key === PAGE_UP || e.key === HOME;
      const isDownKey = e.key === ARROW_DOWN || e.key === PAGE_DOWN || e.key === END || e.key === SPACE;
      if (isUpKey && followingRef.current.following) {
        followingRef.current.following = false;
        setShowJumpToLatest(true);
        cancelPendingFrame();
      } else if (isDownKey) {
        // Browser handles the actual scroll; onScroll will fire and either
        // resume follow (at-bottom) or keep the button visible.
      }
    };

    /** Dragging the scrollbar: the browser doesn't fire wheel, but scroll
     *  events arrive. The same onScroll comparison-vs-programmatic handles
     *  it — when the user drags, scrollTop won't match our written value. */
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollRef, distanceFromBottom, cancelPendingFrame]);

  // --- resize observer ---------------------------------------------------

  useEffect(() => {
    const target = contentRef.current;
    const viewport = scrollRef.current;
    if (!target || !viewport || typeof ResizeObserver === 'undefined') return;

    /** Any size change in the content (text wrap, image load, reasoning-row
     *  expand) or in the viewport itself (window resize, sidebar collapse)
     *  can move the bottom. If the user is following, schedule a follow. */
    const scheduleIfFollowing = (): void => {
      // Snapshot the active id at observation-time so a background conv's
      // mutation (which would only ResizeObserver this very container if
      // we're watching the right DOM, but defensively) doesn't drag us.
      if (activeConvIdRef.current !== currentConversationId) return;
      if (!followingRef.current.following) return;
      scheduleFollowFrame();
    };

    const ro = new ResizeObserver(() => scheduleIfFollowing());
    ro.observe(target);
    ro.observe(viewport);

    return () => {
      ro.disconnect();
    };
  }, [contentRef, scrollRef, currentConversationId, scheduleFollowFrame]);

  // --- unmount cleanup ---------------------------------------------------

  useEffect(() => {
    return () => {
      cancelPendingFrame();
      lastProgrammaticScrollTopRef.current = null;
    };
  }, [cancelPendingFrame]);

  // --- public API --------------------------------------------------------

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    followingRef.current.following = true;
    setShowJumpToLatest(false);
    // Same instant scroll as streaming follow — clicking the button is an
    // explicit "go to bottom", no smooth animation needed.
    scrollToBottom(el);
  }, [scrollRef, scrollToBottom]);

  const requestFollow = useCallback((conversationId: string): void => {
    if (conversationId !== currentConversationId) return;
    followingRef.current.following = true;
    setShowJumpToLatest(false);
    // Two rAFs: first lets the new turn commit, second lets layout settle.
    // Same shape as the historyLoaded effect — the host calls this only
    // AFTER setTurnsByConv has flushed, so a single rAF would usually do,
    // but the double-rAF is cheap insurance against a sync re-layout
    // triggered by the same React commit.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (activeConvIdRef.current !== conversationId) return;
        const el = scrollRef.current;
        if (!el) return;
        scrollToBottom(el);
      });
    });
  }, [currentConversationId, scrollRef, scrollToBottom]);

  return {
    showJumpToLatest,
    jumpToLatest,
    requestFollow,
  };
}
