// AI pane — chat-style conversation with rich rendering.
//
// Layout (flex column, .aipane is the flex container):
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ flex: 0 0 auto — Region 1: TITLE (pinned at top)                   │
//   │   [✦ AI 助手]   current conv title   [＋ new] [🗂 history] [▮▮▮]    │
//   ├────────────────────────────────────────────────────────────────────┤
//   │ flex: 0 0 auto — Region 1b: SCROLL-TRACKED CURRENT QUESTION        │
//   │   (sibling of .aipane__title, NOT nested in it; flex-isolated so   │
//   │    the banner never overlaps with the body content below)           │
//   ├────────────────────────────────────────────────────────────────────┤
//   │ flex: 1 1 0 — Region 2: BODY (scrollable, takes leftover space)    │
//   │   [message turn 1]                                                 │
//   │   [message turn 2]                                                 │
//   │   ...                                                              │
//   ├────────────────────────────────────────────────────────────────────┤
//   │ flex: 0 0 auto — Region 3a: HITL (conditional; sits above composer) │
//   │   [PendingQuestionCard | PendingApprovalCard when active]           │
//   ├────────────────────────────────────────────────────────────────────┤
//   │ flex: 0 0 auto — Region 3: COMPOSER (pinned at bottom)             │
//   │   [textarea, autosize]                          [Send/Stop]        │
//   └────────────────────────────────────────────────────────────────────┘
//
// Five-region contract:
//   - .aipane is `display: flex; flex-direction: column; height: 100%`
//   - .aipane__title, .aipane__currentq-overlay, .aipane__composer are
//     `flex: 0 0 auto` — each pinned in its own box, no overlap with
//     neighbours because every box consumes its own vertical space.
//   - .aipane__body is `flex: 1 1 0; min-height: 0; overflow: auto` —
//     absorbs leftover vertical space and scrolls.
//   - HITL cards slot between body and composer with their own
//     `flex: 0 0 auto` so they push the body up when shown.
//
// Streaming + HITL:
//   - ai:stream (via useAiStream): token / reasoning / toolCall / done / error
//   - ai:user-question-request / ai:user-approval-request: modal cards that
//     post back to ai.userQuestion.answer / ai.userApproval.answer with the
//     server-minted reqId correlation.
//
// Component-level reuse: assistant prose renders through DSH AssistantMarkdown
// (GFM + KaTeX + Shiki); HITL and composer adapters use DSH primitives.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAiStream, useAppEvent, useProviderStatus, useSettings } from '../hooks/useTodoListApi';
import { useChatAutoFollow } from '../hooks/useChatAutoFollow';
import { useDataVersion } from '../data-bus';
import {
  IconEnhanceOutline16,
  IconPlusOutline16,
  IconPaperclipOutline16,
  IconWarningOutline16,
  IconChevronDownOutline14,
  Button,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { IconHistory, IconCollapseBar } from '../components/icons';
import type {
  UserQuestionRequest,
  UserQuestionAnswerItem,
} from '../../shared/ai-types';
import { PROVIDER_LABELS } from '../../shared/ai-types';
import { AI_SUBMIT_EVENT, type ExternalAiSubmitDetail } from '../components/Composer';
import { recoverToolResultValue, parseToolArgs } from '../tool-presentation';
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { AIComposer, type AIComposerAttachment } from '../dsh/AIComposer';
import { PendingQuestionCard } from '../dsh/PendingQuestionCard';
import { PendingApprovalCard } from '../dsh/PendingApprovalCard';
import { AssistantTurnContent } from '../dsh/AssistantTurnContent';
import { AiCreateTaskMessage } from '../components/AiCreateTaskMessage';
import { projectStreamTurn, type AssistantTurnBlock } from '../dsh/stream-turn';
import { normalizeAssistantBlocks } from '../dsh/normalize-assistant-blocks';
import { decodeUserMessage } from '../../shared/task-creation';

type AttachedFile = AIComposerAttachment;

/** One ordered row inside a turn's body. Mirrors DeepSeek's `AssistantBlock`
 *  union (see packages/client/ui-conversation in deepseek-harness) with our
 *  own narrowing for the tool-call block: DSH aggregates a call's args +
 *  result into a single `toolCall` event, so we don't need the
 *  running/settled distinction the upstream `RunningToolCall | ToolResultNode`
 *  carries. The chat-flow renders the three kinds as sibling rows so the
 *  temporal order of reasoning ↔ tool-call ↔ text is preserved end-to-end.
 *  `callId` is a React-stable id; on the renderer-side AIToolCallEvent we
 *  synthesise one from event order because the upstream callId lives in the
 *  DSH session stream (not in our event surface). */
type TurnBlock = AssistantTurnBlock;

interface TurnMetrics {
  /** Turn start (ms, Date.now()) — stamped when runSubmit creates the turn,
   *  before the first ai:stream event. */
  startMs: number;
  /** Arrival ts of the first token event (time-to-first-token numerator). */
  firstTokenMs?: number;
  /** Arrival ts of the done event (turn-end; duration = endMs − startMs). */
  endMs?: number;
  /** Output tokens from runTurn (tok/s numerator). */
  tokensOut?: number;
}

interface Turn {
  id: string;
  user: string;
  /** User intent for this turn. `create-task` renders the dedicated
   *  operation card in TurnView; `chat` (or absent) keeps the plain user
   *  bubble. Persisted through HistoryTurnLike / historyToTurn so reload
   *  shows the same card. */
  userIntent?: 'chat' | 'create-task';
  /** Ordered trace of the assistant turn — reasoning ↔ tool-call ↔ text,
   *  in arrival order. Source of truth for the whole assistant payload;
   *  the legacy `reasoning / assistant / tools` triple has been removed. */
  blocks: TurnBlock[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
  /** Files the user attached to this turn. Rendered as chips above the
   *  bubble; their text body was inlined into the prompt sent to the model. */
  attached?: AttachedFile[];
  /** Turn-level timing + token count, rendered as a metrics tail line once
   *  the turn settles. */
  metrics?: TurnMetrics;
}

interface ConversationRow {
  id: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  // L3-J: optional fields populated by ai.conversation.list (main
  // computes them lazily from the JSONL log). Absent for newly-created
  // conversations that haven't been written to disk yet.
  lastMessagePreview?: string;
  messageCount?: number;
}

/** Shape returned by ai.conversation.history — mirrors DshRuntime.HistoryTurn. */
interface HistoryTurnLike {
  type: 'user' | 'assistant' | 'tool';
  text?: string;
  intent?: 'chat' | 'create-task';
  reasoning?: string;
  /** Wire callId from tool/call (or synthesised `orphan-N` when no matching
   *  call/result was on the wire). Stable React key for tool blocks. */
  callId?: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  data?: unknown;
  presentationMeta?: unknown;
  error?: string;
  /** Explicit lifecycle, mirrored from the live projection (stream-turn.ts).
   *  `missing-result` is NOT an automatic failure. */
  state?: 'done' | 'error' | 'stopped' | 'missing-call' | 'missing-result';
  /** False only for orphan tool/result turns. */
  argsKnown?: boolean;
}

/** Active HITL request — at most one of each kind visible at a time. */
interface ActiveQuestion {
  reqId: string;
  invocationId: string;
  questions: UserQuestionRequest['questions'];
  // Conversation this pending question belongs to. HITL requests are
  // conversation-bound: switching to a different conversation must hide the
  // card (it is not the other conversation's question), and switching back
  // must show it again — so we capture the conv id at request time and only
  // render while the current conversation matches.
  convId: string;
}
interface ActiveApproval {
  reqId: string;
  invocationId: string;
  toolName: string;
  reason: string;
  preview?: string;
  convId: string;
}

export const AIPane: React.FC<{
  onCollapse?: () => void;
  externalSubmit?: ExternalAiSubmitDetail | null;
  onExternalSubmitConsumed?: () => void;
}> = ({ onCollapse, externalSubmit, onExternalSubmitConsumed }) => {
  const { events, clear } = useAiStream();
  const { data: aiSettings } = useSettings();

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // turnsByConv: keyed by conversationId so switching away/back is lossless.
  const [turnsByConv, setTurnsByConv] = useState<Record<string, Turn[]>>({});
  // Per-conversation streaming state: which conv has an in-flight turn, and
  // its id. Stored separately from turnsByConv so events can still resolve
  // a streaming turn after the user navigated to another conversation.
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);

  // L3-D: when DSH's session-title service fires `session/title` (and the
  // runtime listener bridges it back to the conversations table), main
  // pushes `app:data-changed { scope: 'conversations' }`. Bumping this
  // version makes us re-list so the new title appears in the header +
  // sidebar immediately.
  const convVersion = useDataVersion(['conversations']);

  // L5: history is collapsed behind ONE icon (🗂). That single button opens
  // a dropdown that holds: a search/filter box, the full conversation list,
  // a toggle for showing archived, and a "new conversation" entry.
  const [showHistory, setShowHistory] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState<Set<string>>(new Set());
  const [bootError, setBootError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // L3-H: search/filter for the history dropdown. Cleared on dropdown close.
  const [switcherQuery, setSwitcherQuery] = useState('');
  // Per-row actions menu in the history dropdown.
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  // HITL state — the latest unanswered request of each kind. We keep only
  // the most recent because answering replaces the on-screen card; older
  // pending requests are surfaced via timeout by main (the runtime's
  // answerer marks them stale and DSH falls back to a default).
  const [activeQuestion, setActiveQuestion] = useState<ActiveQuestion | null>(null);
  const [activeApproval, setActiveApproval] = useState<ActiveApproval | null>(null);
  // Per-question selection state for multi-select chips (id -> selected labels)
  const [questionSelected, setQuestionSelected] = useState<Record<string, string[]>>({});
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const questionSubmitLock = useRef(false);
  const openedCreatedTodoIdRef = useRef<string | null>(null);

  const historyRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // contentRef: inner content wrapper inside .aipane__body. The auto-follow
  // hook watches this with ResizeObserver so streaming growth (text wrap,
  // image load, reasoning expand) triggers a bottom-pin even though the
  // scroll viewport (.aipane__body) doesn't change size itself.
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Live mirror of currentId for stale-closure-safe guards. The initial-load
  // effect (below) captures `currentId` only at creation time (it deliberately
  // omits currentId from its deps to avoid re-fetching the list on every
  // switch). When the list resolves after runSubmit already created a fresh
  // conversation and set currentId, the captured `!currentId` would read true
  // and OVERRIDE currentId to list[0] (an old, unrelated conversation) —
  // orphaning the in-flight turn (its blocks live under the new convId, which
  // is no longer "current", so the body renders empty). Reading the ref instead
  // sees the live value and skips the override.
  const currentIdRef = useRef<string | null>(currentId);
  currentIdRef.current = currentId;
  // Scroll-tracked "current question": the id of the most recent user turn whose
  // bubble has scrolled fully under the sticky header (no longer visible).
  // The pinned banner shows THIS turn's question so the user always knows
  // what the answer they're reading is answering — without ever duplicating
  // a question bubble that's still on screen. null when no user question has
  // scrolled out of view (e.g. at the top of the conversation).
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  // Vertical push applied to the pinned banner so it hands off smoothly to its
  // own visible bubble instead of stacking a duplicate: while the active
  // bubble is still partially visible just under the header, translateY
  // slides the banner up (negative); once the bubble has fully scrolled
  // under the header it returns to 0 (banner at rest).
  const [pinTranslateY, setPinTranslateY] = useState(0);

  // Files the user picked via the composer's + button. We read them as
  // text in main (app.pickFile), so each entry carries the inlined text
  // body.
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);

  // Initial load: fetch the conversation list. If non-empty, pick the most
  // recent as current. If empty, leave currentId=null and show the empty
  // state — the user starts typing, and submit() allocates the first
  // conversation when they press Enter.
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await window.todoList.conversation.list({ includeArchived: showArchived });
      if (!alive) return;
      if (!res.ok) {
        setBootError(res.message ?? 'list_failed');
        return;
      }
      const list = res.data.conversations;
      setConversations(list);
      // Stale-closure-safe: read the LIVE currentId via the ref, not the
      // captured value. If runSubmit already allocated a conversation (or the
      // user already picked one), do not clobber it with list[0].
      if (!currentIdRef.current && list.length > 0) setCurrentId(list[0]!.id);
    })();
    return () => { alive = false; };
  }, [showArchived, convVersion]);

  // Close popovers on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (showHistory && historyRef.current && !historyRef.current.contains(t)) {
        setShowHistory(false);
        setRowMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showHistory]);

  // L3-H: when the history dropdown opens, focus the search input so the
  // user can type immediately. When it closes, clear the query so the next
  // open starts from the full list.
  useEffect(() => {
    if (showHistory) {
      const t = setTimeout(() => historySearchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setSwitcherQuery('');
    return;
  }, [showHistory]);

  // When currentId changes, lazy-load history (only once per conversation).
  useEffect(() => {
    if (!currentId) return;
    if (historyLoaded.has(currentId)) return;
    let alive = true;
    (async () => {
      const res = await window.todoList.conversation.history(currentId);
      if (!alive) return;
      if (res.ok) {
        const turns = res.data.turns.map(historyToTurn);
        setTurnsByConv((prev) => ({ ...prev, [currentId]: turns }));
        setHistoryLoaded((prev) => new Set(prev).add(currentId));
      }
    })();
    return () => { alive = false; };
  }, [currentId, historyLoaded]);

  // Re-derive the streaming turn through one pure adapter. Keeping the DSH
  // event projection outside this component makes live/history parity and
  // long-stream behavior independently testable.
  useEffect(() => {
    if (!streamingTurnId || !streamingConvId) return;
    const projection = projectStreamTurn(events, streamingTurnId);
    if (projection === null) return;
    if (
      projection.createdTodoId &&
      openedCreatedTodoIdRef.current !== projection.createdTodoId
    ) {
      openedCreatedTodoIdRef.current = projection.createdTodoId;
      // Same hash-mutation the App-level navigate() uses. The App's
      // hashchange listener picks it up and routes to the task detail pane.
      // Wrapped in requestAnimationFrame so the navigate lands after the
      // current event-batch flushes (avoids racing the data-changed
      // broadcast that lands microseconds later).
      requestAnimationFrame(() => {
        location.hash = `#/todo/${projection.createdTodoId}`;
      });
    }
    setTurnsByConv((prev) => {
      const list = prev[streamingConvId] ?? [];
      return {
        ...prev,
        [streamingConvId]: list.map((t) =>
          t.id !== streamingTurnId
            ? t
            : {
                ...t,
                blocks: projection.blocks,
                status: projection.status,
                error: projection.error,
                metrics: {
                  startMs: t.metrics?.startMs ?? Date.now(),
                  firstTokenMs: t.metrics?.firstTokenMs ?? projection.firstTokenTs,
                  ...(projection.endTs != null ? { endMs: projection.endTs } : {}),
                  ...(projection.tokensOut != null ? { tokensOut: projection.tokensOut } : {}),
                },
              },
        ),
      };
    });
  }, [events, streamingConvId, streamingTurnId]);

  // HITL listeners: open the question/approval card the moment main pushes the
  // request event. Correlating reply uses the reqId from the payload (not the
  // invocationId) because the answerer is keyed on reqId server-side. The
  // request is bound to the conversation that was running the turn when it
  // arrived (streamingConvId, falling back to currentId); the card only renders
  // while that conversation is active, so it never bleeds into another one.
  useAppEvent('ai:user-question-request', (req) => {
    setQuestionError(null);
    const convId = streamingConvId ?? currentId ?? '';
    setActiveQuestion({
      reqId: req.reqId,
      invocationId: req.invocationId,
      questions: req.questions,
      convId,
    });
    // Reset selection state — single-select questions default to [] (no
    // selection), multi-select questions default to [] until the user
    // toggles chips. The submit button stays disabled until something is
    // picked.
    setQuestionSelected({});
  });
  useAppEvent('ai:user-approval-request', (req) => {
    const convId = streamingConvId ?? currentId ?? '';
    setActiveApproval({
      reqId: req.reqId,
      invocationId: req.invocationId,
      toolName: req.toolName,
      reason: req.reason,
      preview: req.preview,
      convId,
    });
  });

  // Keep the latest message in view while streaming or switching.
  useAppEvent('ai:user-question-timeout', ({ reqId }) => {
    setActiveQuestion((request) => request?.reqId === reqId ? null : request);
  });
  useAppEvent('ai:user-approval-timeout', ({ reqId }) => {
    setActiveApproval((request) => request?.reqId === reqId ? null : request);
  });

  // Scroll-tracked "current question": recompute which user question has
  // scrolled out of view under the sticky header. The pinned banner mirrors
  // that question so the user never reads an answer without seeing what was
  // asked. We measure against the sticky header's BOTTOM edge (not the
  // viewport top) — once a user bubble's bottom passes under the header it
  // is "no longer visible" and becomes the pinned question. DOM order of
  // the bubbles matches conversation order, so we walk them and the last
  // one scrolled-out-of-view wins. rAF-throttled so scrolling stays smooth.
  const recomputeActiveQuestion = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const head = stickyHeadRef.current;
    // T = bottom edge of the sticky header (the title). A user bubble becomes
    // "active" the moment its TOP crosses under this line — i.e. as soon as
    // it is the topmost question at/under the header. Switching on TOP (not
    // the bottom) is what prevents the lag where the previous question's
    // banner sat over the next answer: the banner updates the instant the
    // next question reaches the top, not after it has fully scrolled past.
    const t = head ? head.getBoundingClientRect().bottom : container.getBoundingClientRect().top;
    // Banner height from the live overlay (0 while no banner is rendered).
    const overlay = container.querySelector<HTMLElement>('.aipane__currentq-overlay');
    const bannerH = overlay ? overlay.getBoundingClientRect().height : 0;
    const bubbles = Array.from(container.querySelectorAll<HTMLElement>('[data-user-q]'));
    let activeIdx = -1;
    for (let i = 0; i < bubbles.length; i++) {
      if (bubbles[i]!.getBoundingClientRect().top <= t + 1) activeIdx = i;
      else break; // conversation-ordered; first not-yet-at-top stops us
    }
    const next = activeIdx >= 0 ? (bubbles[activeIdx]!.dataset.turnId ?? null) : null;
    // Push-up driven by the NEXT user question rising toward the header, so
    // the pinned banner recedes UP — the SAME direction the source question
    // is moving — instead of sliding down (which read as reversed).
    // bannerBottom = title bottom + banner height (the banner's lower edge).
    const bannerBottom = t + bannerH;
    let pinY = 0;
    if (activeIdx >= 0 && bannerH > 0) {
      const nextBubble = activeIdx + 1 < bubbles.length ? bubbles[activeIdx + 1]! : null;
      if (nextBubble) {
        const nextTop = nextBubble.getBoundingClientRect().top;
        pinY = Math.max(-bannerH, Math.min(nextTop - bannerBottom, 0));
      }
    }
    setActiveQuestionId((prev) => (prev === next ? prev : next));
    setPinTranslateY((prev) => (prev === pinY ? prev : pinY));
  }, []);

  // Recompute on scroll (rAF-throttled) and whenever the turn list / active
  // conversation changes (new messages shift layout, so a bubble that was
  // in view may now be scrolled out).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => recomputeActiveQuestion());
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [recomputeActiveQuestion]);

  // Auto-follow the bottom of the conversation stream — but only when the
  // user is at (or near) the bottom. Pauses on upward wheel / touch / keyboard
  // / scrollbar, resumes when they scroll back near the bottom. Driven by
  // ResizeObserver on the content + viewport so streaming chunks, image
  // loads and reasoning-row expands all extend the bottom naturally. The
  // `currentId` + `historyLoaded` pair is the ONLY trigger for the initial
  // pin; `turnsByConv` is intentionally NOT a dependency (a fresh turn
  // contributed by a background conversation must not move this container).
  const { showJumpToLatest, jumpToLatest, requestFollow } = useChatAutoFollow({
    currentConversationId: currentId,
    scrollRef,
    contentRef,
    historyLoaded: currentId ? historyLoaded.has(currentId) : false,
  });

  // Autosize the composer textarea between minHeight and a soft cap. Pure
  // DOM measurement — no external lib. Resets to minHeight when the input is
  // cleared so the box doesn't keep its expanded height with empty content.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const maxH = 220;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }, [input]);

  const current = conversations.find((c) => c.id === currentId) ?? null;
  const currentTurns = useMemo<Turn[]>(
    () => currentId ? turnsByConv[currentId] ?? [] : [],
    [currentId, turnsByConv],
  );
  const busy = streamingTurnId !== null;
  const awaitingAnswer = activeQuestion?.convId === currentId;
  const awaitingApproval = activeApproval?.convId === currentId;
  const providerStatus = useProviderStatus();
  const needsAiSetup = providerStatus.state === 'not-configured';
  // Use the official composer blocking vocabulary at the host boundary.
  const composerBlock: ComposerBlock | undefined = awaitingAnswer
    ? { reason: questionSubmitting ? '正在提交答案…' : '请先回答上方的问题…' }
    : awaitingApproval
      ? { reason: '请先处理上方的操作授权…' }
      : busy
        ? { reason: 'AI 正在回答，请等待或停止生成…' }
        : needsAiSetup
          ? { reason: '请先在设置中完成 AI 模型配置…' }
          : undefined;
  // The question currently pinned at the top of the message stream. This is
  // NOT "the latest user message" — it's the question whose bubble has
  // scrolled out of view under the sticky header (so its answer is what the
  // user is reading right now). null while no user question has scrolled
  // out (top of the conversation), which also means we never render the
  // pinned question twice.
  const activeQuestionTurn = activeQuestionId
    ? (currentTurns.find((t) => t.id === activeQuestionId) ?? null)
    : null;
  // Recompute the pinned question after layout settles (new messages shift
  // positions, so a bubble that was in view may now be scrolled out). Runs
  // after the derivations above so it can depend on currentTurns.
  useLayoutEffect(() => {
    recomputeActiveQuestion();
  }, [recomputeActiveQuestion, currentTurns, currentId]);

  const filteredConversations: ConversationRow[] = switcherQuery
    ? conversations.filter((c) => c.title.toLowerCase().includes(switcherQuery.toLowerCase()))
    : conversations;

  const refreshList = async (): Promise<void> => {
    const res = await window.todoList.conversation.list({ includeArchived: showArchived });
    if (res.ok) setConversations(res.data.conversations);
  };

  const createConversation = async (): Promise<void> => {
    const r = await window.todoList.conversation.create();
    if (!r.ok) return;
    const conv = r.data.conversation;
    setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
    setTurnsByConv((prev) => ({ ...prev, [conv.id]: [] }));
    setHistoryLoaded((prev) => new Set(prev).add(conv.id));
    setCurrentId(conv.id);
    setShowHistory(false);
    setRowMenuId(null);
  };

  // Open the native file picker (main does dialog.showOpenDialog, reads the
  // file as utf-8 up to a small limit) and append the result to the chip
  // row above the textarea. Multi-pick is disabled — adding one file at a
  // time keeps the prompt length predictable; the user can keep clicking
  // + to add more.
  const pickAttachment = async (): Promise<void> => {
    const r = await window.todoList.app.pickFile({ maxBytes: 256 * 1024 });
    if (!r.ok) {
      // not_text / too_large — surface the message in the prompt itself so
      // the user knows what went wrong without leaving the pane.
      setInput((cur) => cur || `[无法附加文件：${r.message ?? r.code ?? '未知错误'}]`);
      return;
    }
    if (r.data.canceled) return;
    const a: AttachedFile = {
      path: r.data.path!,
      name: r.data.name!,
      mime: r.data.mime ?? 'application/octet-stream',
      size: r.data.size ?? (r.data.text?.length ?? 0),
      text: r.data.text ?? '',
    };
    setAttachments((prev) => [...prev, a]);
  };
  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const switchTo = (id: string): void => {
    setShowHistory(false);
    setRowMenuId(null);
    if (id === currentId) return;
    setCurrentId(id);
  };

  const commitRename = async (): Promise<void> => {
    if (!current) return;
    const next = renameDraft.trim();
    if (!next || next === current.title) {
      setRenaming(false);
      return;
    }
    const r = await window.todoList.conversation.rename(current.id, next);
    if (r.ok) {
      const conv = r.data.conversation;
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? conv : c)));
    }
    setRenaming(false);
  };

  const toggleArchive = async (id: string): Promise<void> => {
    const row = conversations.find((c) => c.id === id);
    if (!row) return;
    const r = row.archived
      ? await window.todoList.conversation.unarchive(id)
      : await window.todoList.conversation.archive(id);
    setRowMenuId(null);
    if (!r.ok) return;
    if (id === currentId && row.archived === false) {
      const next = conversations.find((c) => c.id !== id && !c.archived);
      setCurrentId(next?.id ?? null);
    }
    await refreshList();
  };

  const deleteConversation = async (id: string): Promise<void> => {
    const row = conversations.find((c) => c.id === id);
    if (!row) return;
    setRowMenuId(null);
    const confirm = await window.todoList.conversation.confirmDelete(id, row.title);
    if (!confirm.ok || !confirm.data.confirmed) return;
    await window.todoList.conversation.delete(id);
    setTurnsByConv((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setHistoryLoaded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (id === currentId) setCurrentId(remaining[0]?.id ?? null);
  };

  // L3-B: stop the in-flight turn. Soft-cancel the conversation's agent via
  // main; partial tokens/tool results already in flight stay on the screen
  // because the streaming turn remains in turnsByConv.
  const stop = async (): Promise<void> => {
    if (!streamingConvId) return;
    const conv = streamingConvId;
    const inv = streamingTurnId ?? undefined;
    setStreamingConvId(null);
    setStreamingTurnId(null);
    await window.todoList.ai.cancel(conv, inv);
    void refreshList();
  };

  // HITL answerers — fire-and-forget; main's answerer is keyed on reqId and
  // returns ok:false once the pending entry is gone (timeout or already
  // answered), which the renderer treats as success.
  const submitQuestion = async (): Promise<void> => {
    if (!activeQuestion || questionSubmitLock.current) return;
    const answers: UserQuestionAnswerItem[] = activeQuestion.questions.map((q) => {
      const selected = questionSelected[q.id] ?? [];
      return { id: q.id, selected };
    });
    const reqId = activeQuestion.reqId;
    await resolveQuestion(reqId, answers);
  };
  const resolveQuestion = async (reqId: string, answers: UserQuestionAnswerItem[]): Promise<void> => {
    questionSubmitLock.current = true;
    setQuestionSubmitting(true);
    setQuestionError(null);
    try {
      const result = await window.todoList.aiUserQuestion.answer(reqId, answers);
      if (!result.ok) throw new Error(result.message);
      setActiveQuestion((current) => current?.reqId === reqId ? null : current);
    } catch (error) {
      setQuestionError(error instanceof Error ? error.message : '提交失败，请重试');
    } finally {
      questionSubmitLock.current = false;
      setQuestionSubmitting(false);
    }
  };
  const dismissQuestion = async (): Promise<void> => {
    if (!activeQuestion || questionSubmitLock.current) return;
    const reqId = activeQuestion.reqId;
    // Each question is explicitly skipped; the IPC requires a nonempty list.
    await resolveQuestion(reqId, activeQuestion.questions.map((q) => ({ id: q.id, selected: [] })));
  };
  const submitApproval = async (decision: 'allow-once' | 'reject'): Promise<void> => {
    if (!activeApproval) return;
    const reqId = activeApproval.reqId;
    setActiveApproval(null);
    await window.todoList.aiUserApproval.answer(reqId, decision);
  };

  // Submit pipeline shared by the inline composer button AND the Composer
  // modal (which dispatches a window event). Takes an optional override so
  // the Composer path can supply its own prompt + image attachments without
  // having to populate the textarea first.
  const runSubmit = async (override?: ExternalAiSubmitDetail): Promise<void> => {
    // The visual composer is disabled while a turn or HITL request is active,
    // but submissions can also arrive from the centre Composer custom event.
    // Enforce the same single-flight rule at the shared action boundary so no
    // alternate entry point can start a second invocation concurrently. Also
    // gate on needsAiSetup so an external submission can't slip past the
    // disabled textarea when the user has no provider configured yet.
    if (
      streamingTurnId !== null ||
      activeQuestion?.convId === currentId ||
      activeApproval?.convId === currentId ||
      needsAiSetup
    ) return;
    let prompt: string;
    let attached: AttachedFile[];
    if (override) {
      // Composer→AIPane path. The user typed into the modal; we route
      // their text + attached images here without going through the
      // inline textarea. The image markdown is built inline so a
      // multimodal model can see them — DSH's LLM adapter passes image
      // URLs through to the underlying vision-capable provider.
      prompt = override.prompt.trim();
      if (!prompt && override.images.length === 0) return;
      attached = override.images.map((img) => ({
        path: `data:${img.mime};name=${img.name}`,
        name: img.name,
        mime: img.mime,
        size: Math.floor((img.dataUrl.length * 3) / 4),
        text: `[image:${img.name}]\n${img.dataUrl}`,
      }));
    } else {
      prompt = input.trim();
      if (!prompt) return;
      attached = attachments;
    }

    // User intent drives how main wraps the wire prompt: `create-task`
    // becomes a tiny JSON envelope (the ten fixed rules live in the DSH
    // system prompt), plain chat goes through verbatim. The renderer
    // stays out of envelope construction — see `src/shared/task-creation.ts`.
    const userIntent: 'chat' | 'create-task' | undefined = override?.intent;

    let convId = currentId;
    if (!convId) {
      const r = await window.todoList.conversation.create();
      if (!r.ok) return;
      convId = r.data.conversation.id;
      setConversations((prev) => [r.data.conversation, ...prev]);
      setTurnsByConv((prev) => ({ ...prev, [convId!]: [] }));
      setHistoryLoaded((prev) => new Set(prev).add(convId!));
      setCurrentId(convId);
    }

    if (!override) setAttachments([]);

    let finalWire = prompt;
    if (attached.length > 0) {
      const blocks = attached.map((a) => {
        const header = `[attached: ${a.name} (${a.mime}, ${a.size} 字节)]`;
        return `${header}\n${a.text}`;
      });
      finalWire = `${prompt}\n\n---\n\n${blocks.join('\n\n---\n\n')}`;
    }

    const priorTurns = (turnsByConv[convId] ?? [])
      .filter((t) => t.status === 'done' && t.blocks.some((b) => b.kind === 'text'))
      .flatMap((t) => [
        { role: 'user' as const, content: t.user },
        // Concatenate the text blocks of a turn into the assistant message
        // we hand back to the model — reasoning and tool-call traces are
        // intentionally stripped; only the final answer goes on the wire.
        {
          role: 'assistant' as const,
          content: t.blocks
            .filter((b): b is Extract<TurnBlock, { kind: 'text' }> => b.kind === 'text')
            .map((b) => b.text)
            .join(''),
        },
      ]);

    const id = crypto.randomUUID();
    setTurnsByConv((prev) => ({
      ...prev,
      [convId!]: [
        ...(prev[convId!] ?? []),
        // Display the user's literal prompt in the bubble, NOT the wrapped
        // system-instruction version — the user should see exactly what
        // they typed. For create-task the literal text becomes the card
        // description (not a chat bubble).
        { id, user: prompt, userIntent, blocks: [], status: 'streaming', attached: attached.length > 0 ? attached : undefined, metrics: { startMs: Date.now() } },
      ],
    }));
    if (!override) {
      setInput('');
      clear();
    }
    openedCreatedTodoIdRef.current = null;
    setStreamingConvId(convId);
    setStreamingTurnId(id);
    // The user message has now been admitted into the target conversation's
    // list. Ask the auto-follow hook to pin to bottom on the next frame so
    // the bubble is visible — only valid because validation above passed
    // (convId resolved, message added). Invalid submits (empty / blocked /
    // AI-not-configured) bailed out earlier, so this is safe.
    requestFollow(convId);
    const res = await window.todoList.ai.ask({ prompt: finalWire, conversationId: convId, invocationId: id, history: priorTurns, tools: undefined, intent: userIntent });
    // L6-A: the turn's status flip is authoritative HERE, not in the
    // streaming useEffect. The ai:stream `done` event and this IPC reply
    // race: if the IPC resolves first, runSubmit clears streamingTurnId
    // (below) and the useEffect bails at `if (!streamingTurnId) return`
    // before the done event can flip status — the turn stays 'streaming'
    // and the "思考中…" chip / sweep never settle even though the backend
    // finished ("一直显示思考中…但其实已经结束了"). Flipping here
    // (success → done, failure → error) makes the IPC resolve the source
    // of truth; the useEffect's own done-flip becomes a harmless early
    // set this overwrites idempotently. Only !res.ok used to set status
    // here — the success path relied entirely on the racy done event.
    setTurnsByConv((prev) => {
      const list = prev[convId!] ?? [];
      // L6-A: status flip is authoritative HERE (see comment above). The
      // streaming useEffect that normally computes TurnMetrics bails at
      // `if (!streamingTurnId) return` once we clear it below — and the IPC
      // resolve can win that race, leaving metrics unset (no `.aipane__metrics`
      // line, flaky depending on timing). So we ALSO seed metrics here as a
      // fallback: endMs = now, tokensOut from the IPC reply. If the useEffect
      // already computed richer metrics (e.g. firstTokenMs from real
      // streaming chunks), preserve them — only fill the gaps.
      return {
        ...prev,
        [convId!]: list.map((t) => {
          if (t.id !== id) return t;
          if (!res.ok) {
            return { ...t, status: 'error' as const, error: res.message ?? 'AI 调用失败' };
          }
          // L6-B: seed a text block from the IPC reply's content when the
          // streaming useEffect didn't (it bails once streamingTurnId
          // clears, which races this resolve — same reason metrics are
          // seeded here). For a non-streaming adapter the answer only
          // lives in the final `assistant/message`, which runTurn now
          // surfaces as turnResult.content; seeding it here guarantees the
          // assistant bubble renders ("思考中… 然后没有任何内容" bug).
          const blocks = t.blocks.slice();
          // L6-B + L7:兜底只用于"本次没有接收过任何助手内容"的情况。这里
          // 包含 text / reasoning 两种块:如果流式聚合阶段已经采集到了 thinking
          // 但没有 text,我们不能简单地把 done.content 整体再追加成 text——
          // 否则就会变成"思考 + 同一份完整响应 = 重复内容"。判定基准是
          // "是否收到过任何助手内容",而不是"归一化后是否还剩 text"。
          const hasAnyAssistantContent = blocks.some(
            (b) => b.kind === 'text' || b.kind === 'reasoning',
          );
          const content = res.data?.content;
          if (!hasAnyAssistantContent && content) {
            blocks.push({ kind: 'text', text: content });
            // 兜底内容也走一遍归一化,以应对非流式 adapter 把 `<think>...</think>`
            // 字面写进 content 的情况;若已经经过流式归一化(已 hasAssistant),
            // 不会进入这条分支,因此不会重复 normalize。
            blocks.splice(0, blocks.length, ...normalizeAssistantBlocks(blocks, { settled: true }));
          }
          const prevMetrics = t.metrics;
          const metrics: TurnMetrics = {
            startMs: prevMetrics?.startMs ?? Date.now(),
            ...(prevMetrics?.firstTokenMs != null ? { firstTokenMs: prevMetrics.firstTokenMs } : {}),
            endMs: prevMetrics?.endMs ?? Date.now(),
            ...(prevMetrics?.tokensOut != null
              ? { tokensOut: prevMetrics.tokensOut }
              : res.data?.tokensOut != null
                ? { tokensOut: res.data.tokensOut }
                : {}),
          };
          return { ...t, status: 'done' as const, error: undefined, blocks, metrics };
        }),
      };
    });
    setStreamingConvId((cur) => (cur === convId ? null : cur));
    setStreamingTurnId((cur) => (cur === id ? null : cur));
    void refreshList();
  };

  // The Composer modal (center "新建任务" surface) dispatches this event
  // when the user presses Enter. We pick it up here and route it through
  // the same submit pipeline.
  useEffect(() => {
    const onExternalSubmit = (e: Event): void => {
      const detail = (e as CustomEvent<ExternalAiSubmitDetail>).detail;
      if (!detail) return;
      if (detail.intent !== 'create-task') return;
      void runSubmit({ intent: detail.intent, prompt: detail.prompt, images: detail.images });
    };
    window.addEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    return () => window.removeEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    // runSubmit closes over currentId / streamingTurnId / etc.; the listener
    // picks up the latest closure on each event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, turnsByConv, streamingConvId, streamingTurnId, activeQuestion, activeApproval]);

  // App queues AI-create requests while opening/lazy-loading this panel, so
  // submissions are not lost when the panel was collapsed at send time.
  useEffect(() => {
    if (!externalSubmit) return;
    if (
      streamingTurnId !== null ||
      activeQuestion?.convId === currentId ||
      activeApproval?.convId === currentId
    ) return;
    onExternalSubmitConsumed?.();
    void runSubmit(externalSubmit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalSubmit, streamingTurnId, activeQuestion, activeApproval, currentId]);

  return (
    <div className="aipane">
      {/* ===== flex Region 1 (top, flex: 0 0 auto): TITLE =====
          Brand on the left, the active conversation title in the middle,
          the [+] / [🗂] / collapse action buttons on the right. The
          scroll-tracked "current question" overlay sits BELOW this row as
          an absolutely-positioned child so it floats over the top of the
          body content without shifting it. The whole region is a flex
          sibling of the body + composer — previously the title lived
          inside the body as `position: sticky; top: 0`, which worked but
          mixed concerns: sticky positioning inside a scroll container
          vs. flex pinning at the layout root. Restructuring to a flex-
          pinned title region gives a cleaner 3-region layout (title /
          body / composer) and makes the title's pinned state explicit in
          the layout itself. See the file header for the diagram. */}
      <div className="aipane__title" ref={stickyHeadRef}>
        <div className="aipane__title-row">
          <div className="aipane__brand">
            <span className="aipane__brand-glyph" aria-hidden="true">
              <IconEnhanceOutline16 size={14} />
            </span>
            <span className="aipane__brand-text">AI 助手</span>
          </div>
          {/* The conversation title sits next to the brand; a single spacer
              (.aipane__title-spacer) absorbs the leftover horizontal space
              between title and actions so the actions stay glued to the
              right edge regardless of title length. Two-spacer symmetric
              centering was tried earlier but the right-edge margin-left:auto
              on .aipane__actions fought the right spacer for the same
              space — long titles pushed actions off-screen. One spacer +
              margin-left:auto is the canonical 3-zone flex pattern. */}
          {!bootError && current && (
            <h2 className="aipane__conv-title" title={current.title}>
              {renaming ? (
                <input
                  ref={renameInputRef}
                  className="aipane__rename"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                    if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
                  }}
                  onBlur={() => void commitRename()}
                  aria-label="重命名对话"
                />
              ) : (
                current.title
              )}
            </h2>
          )}
          <div className="aipane__title-spacer" />
          <div className="aipane__actions">
            <button
              type="button"
              className="icon-btn aipane__new-btn"
              onClick={() => void createConversation()}
              title="新建对话"
              aria-label="新建对话"
            >
              <IconPlusOutline16 />
            </button>
            <div className="aipane__history" ref={historyRef}>
              <button
                type="button"
                className="icon-btn aipane__history-btn"
                onClick={() => setShowHistory((s) => !s)}
                title="对话历史"
                aria-label="对话历史"
                aria-haspopup="listbox"
                aria-expanded={showHistory}
              >
                <IconHistory />
              </button>
              {showHistory && (
                <div className="aipane__menu aipane__menu--right" role="listbox">
                  <div className="aipane__menu-head">
                    <span className="aipane__menu-head-title">对话历史</span>
                  </div>
                  <div className="aipane__search">
                    <input
                      ref={historySearchRef}
                      type="search"
                      className="aipane__search-input"
                      placeholder="搜索对话标题…"
                      value={switcherQuery}
                      onChange={(e) => setSwitcherQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          if (switcherQuery) setSwitcherQuery('');
                          else setShowHistory(false);
                          return;
                        }
                        if (e.key === 'Enter' && filteredConversations.length > 0) {
                          e.preventDefault();
                          switchTo(filteredConversations[0]!.id);
                        }
                      }}
                      aria-label="搜索对话"
                    />
                  </div>
                  {filteredConversations.length === 0 && conversations.length === 0 && (
                    <div className="aipane__menu-empty">还没有对话</div>
                  )}
                  {filteredConversations.length === 0 && conversations.length > 0 && switcherQuery && (
                    <div className="aipane__menu-empty">
                      没有匹配“{switcherQuery}”的对话
                    </div>
                  )}
                  {filteredConversations.length > 0 && switcherQuery && (
                    <div className="aipane__menu-hint">
                      {filteredConversations.length} / {conversations.length} 个匹配
                    </div>
                  )}
                  {filteredConversations.map((c) => (
                    <div key={c.id} className="aipane__menu-row">
                      <button
                        type="button"
                        role="option"
                        aria-selected={c.id === currentId}
                        className={`aipane__menu-item${c.id === currentId ? ' aipane__menu-item--active' : ''}`}
                        onClick={() => switchTo(c.id)}
                        title={c.title}
                      >
                        <span className="aipane__menu-line">
                          <span className="aipane__menu-title">{c.title}</span>
                          {c.archived && <span className="aipane__menu-tag">已归档</span>}
                        </span>
                        {(c.lastMessagePreview || typeof c.messageCount === 'number') && (
                          <span className="aipane__menu-preview">
                            {c.lastMessagePreview && (
                              <span className="aipane__menu-preview-text">{c.lastMessagePreview}</span>
                            )}
                            {typeof c.messageCount === 'number' && (
                              <span className="aipane__menu-count" title={`${c.messageCount} 条对话`}>
                                {c.messageCount}
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="icon-btn aipane__menu-row-btn"
                        onClick={() => setRowMenuId((cur) => (cur === c.id ? null : c.id))}
                        title="对话操作"
                        aria-label={`对 "${c.title}" 的操作`}
                        aria-haspopup="menu"
                        aria-expanded={rowMenuId === c.id}
                      >
                        ⋯
                      </button>
                      {rowMenuId === c.id && (
                        <div className="aipane__menu aipane__menu--row" role="menu">
                          <button type="button" className="aipane__menu-item aipane__menu-item--inline" onClick={() => { setRowMenuId(null); beginRenameFor(c); }}>
                            重命名
                          </button>
                          <button type="button" className="aipane__menu-item aipane__menu-item--inline" onClick={() => void toggleArchive(c.id)}>
                            {c.archived ? '取消归档' : '归档'}
                          </button>
                          <div className="aipane__menu-divider" />
                          <button type="button" className="aipane__menu-item aipane__menu-item--inline aipane__menu-item--danger" onClick={() => void deleteConversation(c.id)}>
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="aipane__menu-divider" />
                  <button
                    type="button"
                    className="aipane__menu-item aipane__menu-item--toggle"
                    onClick={() => { setShowHistory(false); setRowMenuId(null); setShowArchived((s) => !s); }}
                  >
                    {showArchived ? '隐藏已归档' : '显示已归档'}
                  </button>
                </div>
              )}
            </div>
            {/* Collapse affordance — the IconCollapseBar lives ON the panel
                header itself, not in a separate grip divider column, so the
                user perceives it as "part of the area" they're looking at.
                Sits at the right edge of the title row, after the new/history
                actions, so it reads as a chrome-level toggle without
                competing for attention with the in-panel controls. */}
            {onCollapse && (
              <button
                type="button"
                className="icon-btn aipane__collapse-btn"
                onClick={onCollapse}
                title="收起 AI 助手"
                aria-label="收起 AI 助手"
              >
                <IconCollapseBar />
              </button>
            )}
          </div>
        </div>
      </div>

      {needsAiSetup && aiSettings && (
        <div className="aipane__provider-notice" role="status">
          <IconWarningOutline16 size={16} />
          <span className="aipane__provider-notice-copy">
            <strong>AI 尚未配置</strong>
            <span>请先配置 {PROVIDER_LABELS[aiSettings.provider]}，再开始对话。</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { location.hash = '#/settings'; }}
          >
            打开设置
          </Button>
        </div>
      )}

      {/* Scroll-tracked "current question" pin — INDEPENDENT flex sibling of
          .aipane__title / .aipane__body / .aipane__composer. Sits as Region 1b
          between title and body so it occupies its OWN box in the column
          flex. The body (Region 2, flex: 1 1 0) shrinks to make room, and
          the banner can NEVER overlap with the body's first user bubble
          (which is what happened when this was absolute + inside the title
          region — the banner and the live bubble stacked at the same y).
          pointer-events:none keeps the overlay from blocking scroll or hit-
          testing on the body. */}
      {!bootError && activeQuestionTurn && (
        <div
          className="aipane__currentq-overlay"
          aria-hidden="false"
          // Hand-off animation lives in CSS via the --pin-y custom
          // property. transform is composited (no layout/paint on scroll).
          style={{ '--pin-y': `${pinTranslateY}px` } as React.CSSProperties}
        >
          <div className="aipane__currentq-pin bubble bubble--user" role="status" aria-label="当前问题">
            <span className="aipane__currentq-text">
              {activeQuestionTurn.user}
              {activeQuestionTurn.attached && activeQuestionTurn.attached.length > 0 && (
                <span className="aipane__currentq-attach">
                  {' '}<IconPaperclipOutline16 size={11} /> {activeQuestionTurn.attached.length} 个附件
                </span>
              )}
            </span>
            {busy && activeQuestionTurn.id === streamingTurnId && (
              <span className="aipane__currentq-status" aria-live="polite">生成中…</span>
            )}
          </div>
        </div>
      )}

      {/* ===== flex Region 2 (middle, flex: 1 1 0; min-height: 0): BODY SHELL =====
          Outer wrapper is a column flex; the actual scroll viewport is the
          inner .aipane__body, and the .aipane__messages div is its content
          (which useChatAutoFollow ResizeObserves). The jump-to-latest button
          is absolutely positioned over the shell so it can sit on top of the
          scroll viewport without taking layout space — clicking it must NOT
          shift the message area's height. */}
      <div className="aipane__body-shell">
        <div className="aipane__body" role="log" aria-live="polite" ref={scrollRef}>
          <div className="aipane__messages" ref={contentRef}>
            {bootError && (
              <div className="aipane__empty aipane__empty--error">
                <IconWarningOutline16 size={14} /> 会话列表加载失败：{bootError}
              </div>
            )}
            {!bootError && !current && conversations.length === 0 && (
              <div className="aipane__empty">
                <p>直接在下方输入问题，回车即创建第一条对话。</p>
              </div>
            )}
            {!bootError && current && currentTurns.length === 0 && (
              <div className="aipane__empty">
                <p>这条对话还没有消息。在下方输入问题开始：</p>
              </div>
            )}
            {currentTurns.map((t) => <TurnView key={t.id} turn={t} />)}
          </div>
        </div>
        {showJumpToLatest && currentId && (
          <Button
            variant="primary"
            size="sm"
            className="aipane__jump-to-latest"
            onClick={jumpToLatest}
            aria-label="回到最新消息"
          >
            <IconChevronDownOutline14 size={14} />
            <span>回到最新</span>
          </Button>
        )}
      </div>

      {/* HITL cards — sit just ABOVE the composer so the user sees the
          question right next to where they answer, never buried at the
          bottom. Each request is bound to the conversation that was running
          the turn when it arrived; only render it while that conversation is
          the active one so it never bleeds into a different conversation on
          switch. */}
      {activeQuestion && activeQuestion.convId === currentId && (
        <PendingQuestionCard
          questions={activeQuestion.questions}
          submitting={questionSubmitting}
          error={questionError}
          selected={questionSelected}
          onToggle={(qid, label, multi) => {
            setQuestionSelected((prev) => {
              const cur = prev[qid] ?? [];
              if (multi) {
                return { ...prev, [qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
              }
              // single-select — replace; clicking the same label clears.
              return { ...prev, [qid]: cur.length === 1 && cur[0] === label ? [] : [label] };
            });
          }}
          onSubmit={() => void submitQuestion()}
          onSkip={() => void dismissQuestion()}
        />
      )}
      {activeApproval && activeApproval.convId === currentId && (
        <PendingApprovalCard
          toolName={activeApproval.toolName}
          reason={activeApproval.reason}
          preview={activeApproval.preview}
          onAllow={() => void submitApproval('allow-once')}
          onReject={() => void submitApproval('reject')}
        />
      )}

      {/* ===== flex Region 3 (bottom, flex: 0 0 auto): COMPOSER =====
          Pinned at bottom. The composer card grows naturally with its
          textarea (autosize up to a soft cap) and the body's
          `min-height: 0` gives way when a long turn expands the stream.
          The AIComposer primitive owns its own internal layout (.composer-
          card / .composer-actions); the host only needs to position it. */}
      <AIComposer
        ref={textareaRef}
        value={input}
        onChange={setInput}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onPickAttachment={() => void pickAttachment()}
        onSubmit={() => void runSubmit()}
        onStop={() => void stop()}
        busy={busy}
        hasConversation={current !== null}
        block={composerBlock}
      />
    </div>
  );

  /** Inline rename helper: same flow as beginRename() but for a chosen row,
   *  not necessarily the currently-active conversation. */
  function beginRenameFor(c: ConversationRow): void {
    setRenameDraft(c.title);
    setRenaming(true);
    setCurrentId(c.id);
    setShowHistory(false);
    setRowMenuId(null);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }
};
/** Convert a HistoryTurn (from JSONL decode) into the renderer's Turn shape.
 *  Each history item becomes one Turn in the UI; the temporal interleaving
 *  promised by `blocks` only matters when several events share a turn — so
 *  the user / tool items stay blockless and the assistant item gets the
 *  ordered [reasoning?, text?] pair (reasoning always before text inside
 *  one assistant step). */
function historyToTurn(h: HistoryTurnLike): Turn {
  if (h.type === 'user') {
    const rawText = h.text ?? '';
    // Defense in depth: `h.intent` 是 main 侧 foldHistory 已经填好的权威
    // 字段，但若将来 IPC schema 改动或上游某条路径漏写 intent，渲染端
    // 仍能从 envelope 文本本身识别 create-task——保证「创建任务」卡片
    // 在重启回放时不丢样式。`decodeUserMessage` 是纯函数、never-throws，
    // 只在加载历史时跑一次，不在流式热路径上。
    const userIntent: 'chat' | 'create-task' | undefined =
      h.intent ?? (decodeUserMessage(rawText).intent ?? undefined);
    return {
      id: crypto.randomUUID(),
      user: rawText,
      userIntent,
      blocks: [],
      status: 'done',
    };
  }
  if (h.type === 'assistant') {
    const blocks: TurnBlock[] = [];
    const reasoning = h.reasoning ?? '';
    const text = h.text ?? '';
    // Order matters: the historical JSONL flattens each assistant step
    // into a single record with both fields; reasoning always precedes
    // the answer text inside that step, so blocks are built in that order.
    if (reasoning) blocks.push({ kind: 'reasoning', text: reasoning });
    if (text) blocks.push({ kind: 'text', text });
    // settled=true:历史数据已固定,残片降级 prose;`<think>` 出现在 text 段
    // 开头时,把内联标签解析成 reasoning 块(与实时投影一致)。
    const normalized = normalizeAssistantBlocks(blocks, { settled: true });
    return {
      id: crypto.randomUUID(),
      user: '',
      blocks: normalized,
      status: 'done',
    };
  }
  // tool — the historical record carries the real callId (or a synthesised
  // orphan-N one), the explicit lifecycle state, and an argsKnown flag so
  // the rendered ToolRow can distinguish "args = {}" from "未记录输入".
  // Older history logs that don't carry these new fields fall back to the
  // synthesised `hist-...` key + `argsKnown=true` (we DO have the call) +
  // `state=ok ? 'done' : 'error'` so reload of pre-fix sessions still works.
  const legacyCallId = `hist-${h.name ?? 'tool'}-${(() => {
    try { return JSON.stringify(h.args ?? null); } catch { return ''; }
  })()}`;
  const callId = h.callId ?? legacyCallId;
  const argsKnown = h.argsKnown ?? true;
  const state: 'done' | 'error' | 'stopped' | 'missing-call' | 'missing-result' =
    h.state ?? ((h.ok ?? false) ? 'done' : 'error');
  // `ok` mirrors the project's projectStreamTurn invariant: true iff
  // state==='done'. `error` and `stopped` rows paint a red/amber dot;
  // `missing-result` and `missing-call` rows paint the neutral pill.
  const ok = state === 'done';
  return {
    id: crypto.randomUUID(),
    user: '',
    blocks: [{
      kind: 'tool-call',
      callId,
      name: h.name ?? '',
      // L5-A: history carries the same wrapped ContentBlock[] the live wire
      // does (foldHistory stores block.content verbatim). Recover the raw
      // value + parse the args JSON string so presentToolResult renders the
      // right card instead of a <pre>[{"type":"text"...}]</pre> dump.
      args: parseToolArgs(h.args),
      argsKnown,
      result: h.ok ? recoverToolResultValue(h.data) : h.error,
      resultKnown: Boolean(h.data != null || (h.error != null && h.error !== '')),
      presentationMeta: h.presentationMeta,
      ok,
      state,
    }],
    status: 'done',
  };
}

/** Format a millisecond duration for the turn-metrics line: sub-minute
 *  durations show one decimal (< 10s) or none; minute+ shows m分s秒. */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : String(Math.round(s))}秒`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}分${rs}秒`;
}

/** T4: render the turn-metrics tail line — `21:21 · 用时 28秒 · 首 token 0.9秒 · 124 tok/s`.
 *  Returns null until the turn has settled (endMs present). */
function formatTurnMetrics(m: TurnMetrics): string | null {
  if (m.endMs == null) return null;
  const parts: string[] = [];
  const d = new Date(m.endMs);
  parts.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  const durMs = m.endMs - m.startMs;
  if (durMs >= 0) parts.push(`用时 ${fmtDuration(durMs)}`);
  if (m.firstTokenMs != null) {
    const ttft = m.firstTokenMs - m.startMs;
    if (ttft >= 0) parts.push(`首 token ${(ttft / 1000).toFixed(1)}秒`);
  }
  if (m.tokensOut != null && m.tokensOut > 0 && durMs > 0) {
    const tps = Math.round(m.tokensOut / (durMs / 1000));
    if (tps > 0) parts.push(`${tps} tok/s`);
  }
  return parts.join(' · ');
}

const TurnView: React.FC<{ turn: Turn }> = ({ turn }) => {
  const { blocks, status, userIntent } = turn;
  // Create-task intent → dedicated operation card. Plain chat (or absent
  // intent on older turns) keeps the regular user bubble. The card uses
  // the same `data-user-q` / `data-turn-id` hooks so the scroll-tracked
  // pinned-question tracker still works without a code change.
  const isCreateTask = userIntent === 'create-task';
  return (
    <div className="turn">
      {turn.attached && turn.attached.length > 0 && (
        <div className="turn__attachments" aria-label="已附加的文件">
          {turn.attached.map((a) => (
            <span key={a.path} className="turn__attach-chip" title={`${a.path}\n${a.mime} · ${a.size} 字节`}>
              <span aria-hidden="true"><IconPaperclipOutline16 size={11} /></span> {a.name}
            </span>
          ))}
        </div>
      )}
      {turn.user && (isCreateTask ? (
        <AiCreateTaskMessage description={turn.user} turnId={turn.id} />
      ) : (
        <div className="bubble bubble--user" data-user-q data-turn-id={turn.id}>
          {turn.user}
        </div>
      ))}
      <AssistantTurnContent blocks={blocks} status={status} error={turn.error} />
      {(() => {
        const line = turn.metrics ? formatTurnMetrics(turn.metrics) : null;
        return line ? <div className="aipane__metrics">{line}</div> : null;
      })()}
    </div>
  );
};
