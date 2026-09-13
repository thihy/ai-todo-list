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
//
// Scheduler model
// ---------------
// Every "go to bottom" intent (historyLoaded first-paint, requestFollow after
// a new turn commits, ResizeObserver on content growth) is funnelled through
// `scheduleFollowFrame`. The scheduler keeps the latest rAF handle in a ref so
// bursts coalesce into one scroll, and so user-driven "stop following" can
// cancel them before the write happens. We additionally tag each scheduled
// frame with:
//
//   - the target conversation id it was scheduled for
//   - a monotonically increasing `generation` counter
//
// Switching conversations, the user pausing follow, and component unmount all
// bump the generation AND cancel the pending frame. The frame's check on
// execution compares both the live id and the live generation — only if
// BOTH still match the snapshot it carries do we write to scrollTop. This is
// what stops "user scrolled up, but the rAF queued at send-time yanks them
// back" after the user has explicitly opted out of following.

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
   *  conversations meanwhile, the frame is a no-op.
   *
   *  The conversation id argument is authoritative: if it does not match
   *  `currentConversationId` at call time, the request is ignored. Callers
   *  should pass the id of the conversation they want the follow to apply
   *  to (which may equal `currentConversationId`, or — when a brand-new
   *  conversation was just created — equal the brand-new id). */
  requestFollow: (conversationId: string) => void;
}

interface FollowState {
  following: boolean;
}

/** A snapshot captured at schedule time and re-checked at execution time.
 *  Both fields must still match the live hook state for the write to
 *  happen. The generation counter is bumped on conv switch / unmount /
 *  pause-follow, invalidating every still-queued frame in one step. */
interface ScheduledFrame {
  /** The id the request was scheduled FOR. */
  forConversationId: string | null;
  /** Generation captured at schedule time. */
  generation: number;
  /** The rAF handle so we can cancel it before it fires. */
  rafId: number;
}

export function useChatAutoFollow(opts: UseChatAutoFollowOpts): UseChatAutoFollowResult {
  const { currentConversationId, scrollRef, contentRef, historyLoaded } = opts;

  // `followingRef` mirrors "is the user currently sticky-to-bottom" without
  // forcing re-renders. The visible UI (jump-to-latest button) reads from
  // `showJumpToLatest` state, which lags the ref by one frame to keep DOM
  // measurements cheap.
  const followingRef = useRef<FollowState>({ following: true });

  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Currently-queued frame, if any. Single handle shared by content growth /
  // resize / requestFollow so bursts coalesce into one scroll.
  const pendingFrameRef = useRef<ScheduledFrame | null>(null);

  // Generation counter — bumped on conv switch / pause-follow / unmount.
  // Any frame whose captured generation < this value has been invalidated.
  const generationRef = useRef(0);

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
    const pending = pendingFrameRef.current;
    if (pending !== null) {
      cancelAnimationFrame(pending.rafId);
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
   *  second call within the same frame just re-arms to the same handle.
   *
   *  `forConversationId` is the id the caller believes it wants the follow
   *  to land on. We snapshot both that id and the current generation so
   *  the rAF can re-validate before writing scrollTop. */
  const scheduleFollowFrame = useCallback((forConversationId: string | null): void => {
    if (pendingFrameRef.current !== null) return;
    const generation = generationRef.current;
    const rafId = requestAnimationFrame(() => {
      // Clear our handle ref first so a follow-up schedule during this
      // callback isn't suppressed by stale-state bookkeeping.
      pendingFrameRef.current = null;
      const convId = activeConvIdRef.current;
      const el = scrollRef.current;
      if (!el) return;
      // Background conversations don't drive this container. If the active
      // id changed since scheduling, drop the scroll silently.
      if (convId !== activeConvIdRef.current) return;
      // Generation invalidation: conv switch / pause-follow / unmount all
      // bumped the counter, and any old frame captured at a lower number
      // must not write.
      if (generation !== generationRef.current) return;
      // Caller asked for a specific id (e.g. a freshly created conversation
      // whose state hasn't propagated yet). When that id no longer matches
      // the live id (user switched away, generation bumped, etc.), drop it.
      if (forConversationId !== null && forConversationId !== convId) return;
      if (!followingRef.current.following) return;
      scrollToBottom(el);
      // Button reflects the post-scroll state: at-bottom ⇒ hide.
      setShowJumpToLatest(false);
    });
    pendingFrameRef.current = { forConversationId, generation, rafId };
  }, [scrollRef, scrollToBottom]);

  // --- conversation-id lifecycle ----------------------------------------

  // Switching conversations resets everything: drop the frame, reset
  // following to true (a fresh conversation starts at the bottom), hide the
  // button, AND bump the generation so any still-queued frame (with the
  // old generation captured) becomes a no-op when it fires.
  useEffect(() => {
    generationRef.current += 1;
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
  // subsequent growth is picked up by the ResizeObserver. Goes through the
  // unified scheduler so a conv-switch / pause-follow in the same frame
  // cancels it cleanly.
  useEffect(() => {
    if (!historyLoaded) return;
    scheduleFollowFrame(currentConversationId);
  }, [historyLoaded, currentConversationId, scheduleFollowFrame]);

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
        // Bump generation so any still-queued frame (e.g. one scheduled at
        // send-time before the user scrolled up) becomes a no-op even if
        // cancelPendingFrame somehow misses it. Belt-and-braces with the
        // explicit cancel below.
        generationRef.current += 1;
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
        generationRef.current += 1;
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
        generationRef.current += 1;
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
     *  it — when the user drags, scrollTop won't match our written value.
     *  Note: a scrollbar drag can also leave us above the bottom, in which
     *  case onScroll sets following=false. We also bump the generation so
     *  any queued follow frame can't drag the user back during the drag. */
    const onPointerDown = (e: PointerEvent): void => {
      // Only care about drags on the scrollbar area — buttons inside the
      // content area are handled by their own listeners. The scrollbar
      // lives in the gap between clientWidth and offsetWidth.
      const onScrollbar = e.clientX >= el.clientWidth;
      if (onScrollbar && followingRef.current.following) {
        // We don't know yet whether the user is dragging up or down; just
        // record that we're now in a "maybe leaving the bottom" state and
        // cancel the queued frame. onScroll will sort out the rest once
        // the drag actually moves the scroll position.
        generationRef.current += 1;
        cancelPendingFrame();
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('pointerdown', onPointerDown, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('pointerdown', onPointerDown);
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
      scheduleFollowFrame(currentConversationId);
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
      // Bump the generation so any in-flight frame — even if it sneaks
      // past the rAF cancellation — becomes a no-op when it fires. Then
      // cancel and reset bookkeeping.
      generationRef.current += 1;
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
    // explicit "go to bottom", no smooth animation needed. No rAF: the
    // user gesture is the explicit intent, and the layout is already
    // settled by the time the click event runs.
    scrollToBottom(el);
  }, [scrollRef, scrollToBottom]);

  const requestFollow = useCallback((conversationId: string): void => {
    // Do NOT drop the request based on `currentConversationId` here. The
    // prop value lags behind React commits: when a brand-new conversation
    // is created in the same submit pipeline that just called
    // `setCurrentId(convId)`, the hook still sees the OLD id until React
    // re-renders. Dropping here would silently lose the follow for the
    // first message of a fresh conversation.
    //
    // Instead we hand the target id to the scheduler as `forConversationId`
    // and let the frame's execution-time check
    // (`forConversationId !== activeConvIdRef.current`) drop the request
    // if the active id never caught up (i.e. the user switched away
    // between submit and frame-fire). The generation check covers the
    // user-paused-follow case.
    followingRef.current.following = true;
    setShowJumpToLatest(false);
    scheduleFollowFrame(conversationId);
  }, [scheduleFollowFrame]);

  return {
    showJumpToLatest,
    jumpToLatest,
    requestFollow,
  };
}