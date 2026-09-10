// AI pane — chat-style conversation with rich rendering.
//
// Layout (L5 redesign):
//   ┌─ header (minimal): [✦ AI 助手]              [＋ new] [🗂 history]  ┐
//   ├─ content ───────────────────────────────────────────────────────────┤
//   │  # 当前对话标题  (big sticky heading)                                │
//   │  ┌─ 当前问题 ───────────────────────────────────────────────────┐   │  ← sticky banner
//   │  │ "用户问的问题"                                                │   │
//   │  └──────────────────────────────────────────────────────────────┘   │
//   │  [message turn 1]                                                   │
//   │  [message turn 2]                                                   │
//   │  ...                                                                │
//   ├─ composer (unified input box) ───────────────────────────────────────┤
//   │  + │  [textarea, multi-line, autosize]                [Send/Stop]   │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Streaming + HITL:
//   - ai:stream (via useAiStream): token / reasoning / toolCall / done / error
//   - ai:user-question-request / ai:user-approval-request: modal cards that
//     post back to ai.userQuestion.answer / ai.userApproval.answer with the
//     server-minted reqId correlation.
//
// Component-level reuse: assistant bubbles render via DSH MarkdownText
// (GFM + KaTeX + Shiki); the HITL cards use DSH Button + Pill for affordances
// that share the rest of the app's design tokens.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAiStream, useAppEvent } from '../hooks/useTodoListApi';
import { useDataVersion } from '../data-bus';
import { Markdown } from '../components/Markdown';
import { Button, DisclosureRow, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  IconHistory,
  IconPlus,
  IconClose,
  IconSend,
  IconStop,
  IconAttach,
  IconSparkle,
  IconThink,
  IconTool,
  IconWarn,
} from '../components/icons';
import type {
  AIStreamEvent,
  UserQuestionRequest,
  UserQuestionAnswerItem,
} from '../../shared/ai-types';
import { AI_SUBMIT_EVENT, type ExternalAiSubmitDetail } from '../components/Composer';

// Reference-stable labels for any MarkdownText used directly inside this
// component (HITL bodies etc.) are NOT needed — we always render through
// the shared <Markdown> wrapper which already hoists its own labels.

interface ToolCard {
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
}

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
type TurnBlock =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; callId: string; name: string; args: unknown; result: unknown; ok: boolean }
  | { kind: 'text'; text: string };

/** A file the user picked via the composer's + button. main reads the file
 *  and gives us the inlined text body so the prompt can carry the content
 *  directly. Path/name stay around for the chip label and the mention in
 *  the sent prompt so the model knows which file the body came from. */
interface AttachedFile {
  path: string;
  name: string;
  mime: string;
  size: number;
  text: string;
}

interface Turn {
  id: string;
  user: string;
  reasoning: string;
  assistant: string;
  tools: ToolCard[];
  /** Ordered trace of the assistant turn: reasoning ↔ tool-call ↔ text
   *  blocks in the order events arrived. New code should read this; the
   *  three string/array fields above are kept as derived fallbacks during
   *  the migration and will be removed once every reader switches over. */
  blocks: TurnBlock[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
  /** Files the user attached to this turn. Rendered as chips above the
   *  bubble; their text body was inlined into the prompt sent to the model. */
  attached?: AttachedFile[];
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
  reasoning?: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  data?: unknown;
  error?: string;
}

/** Active HITL request — at most one of each kind visible at a time. */
interface ActiveQuestion {
  reqId: string;
  invocationId: string;
  questions: UserQuestionRequest['questions'];
}
interface ActiveApproval {
  reqId: string;
  invocationId: string;
  toolName: string;
  reason: string;
  preview?: string;
}

export const AIPane: React.FC = () => {
  const { events, clear } = useAiStream();

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

  const historyRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      if (!currentId && list.length > 0) setCurrentId(list[0]!.id);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Re-derive the streaming turn from its events.
  //
  // Walk events in arrival order and build an ordered `blocks` array — this
  // is the canonical representation going forward (it preserves the temporal
  // interleaving of reasoning ↔ tool-call ↔ text that the previous
  // three-bucket filter/join destroyed). The three legacy fields below are
  // re-derived from `blocks` so existing readers keep working during the
  // migration and will be dropped in step 7.
  useEffect(() => {
    if (!streamingTurnId || !streamingConvId) return;
    const mine = events.filter((e) => e.invocationId === streamingTurnId);
    if (mine.length === 0) return;
    const blocks: TurnBlock[] = [];
    let toolSeq = 0;
    for (const ev of mine) {
      if (ev.type === 'reasoning') {
        if (!ev.text) continue;
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'reasoning') last.text += ev.text;
        else blocks.push({ kind: 'reasoning', text: ev.text });
      } else if (ev.type === 'token') {
        if (!ev.token) continue;
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'text') last.text += ev.token;
        else blocks.push({ kind: 'text', text: ev.token });
      } else if (ev.type === 'toolCall') {
        // DSH aggregates a call's args + result into one event, so each event
        // is a single block. callId is a stable React key; we don't get a
        // real callId from the renderer-side event, so synthesize one from
        // the event's order in this turn (deterministic per rebuild).
        blocks.push({
          kind: 'tool-call',
          callId: `tool-${toolSeq++}`,
          name: ev.toolName,
          args: ev.args,
          result: ev.result,
          ok: ev.ok,
        });
      }
    }
    // Derive legacy fields for any reader that still uses them.
    let reasoning = '';
    let assistant = '';
    const tools: ToolCard[] = [];
    for (const b of blocks) {
      if (b.kind === 'reasoning') reasoning += b.text;
      else if (b.kind === 'text') assistant += b.text;
      else tools.push({ name: b.name, args: b.args, result: b.result, ok: b.ok });
    }
    const done = mine.some((e) => e.type === 'done');
    const errEvt = mine.find((e): e is Extract<AIStreamEvent, { type: 'error' }> => e.type === 'error');
    setTurnsByConv((prev) => {
      const list = prev[streamingConvId] ?? [];
      return {
        ...prev,
        [streamingConvId]: list.map((t) =>
          t.id !== streamingTurnId
            ? t
            : {
                ...t,
                reasoning,
                assistant,
                tools,
                blocks,
                status: errEvt ? 'error' : done ? 'done' : 'streaming',
                error: errEvt?.message,
              },
        ),
      };
    });
  }, [events, streamingConvId, streamingTurnId]);

  // HITL listeners: open the question/approval card the moment main pushes the
  // request event. Correlating reply uses the reqId from the payload (not the
  // invocationId) because the answerer is keyed on reqId server-side.
  useAppEvent('ai:user-question-request', (req) => {
    setActiveQuestion({
      reqId: req.reqId,
      invocationId: req.invocationId,
      questions: req.questions,
    });
    // Reset selection state — single-select questions default to [] (no
    // selection), multi-select questions default to [] until the user
    // toggles chips. The submit button stays disabled until something is
    // picked.
    setQuestionSelected({});
  });
  useAppEvent('ai:user-approval-request', (req) => {
    setActiveApproval({
      reqId: req.reqId,
      invocationId: req.invocationId,
      toolName: req.toolName,
      reason: req.reason,
      preview: req.preview,
    });
  });

  // Keep the latest message in view while streaming or switching.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnsByConv, currentId]);

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
  const currentTurns: Turn[] = currentId ? turnsByConv[currentId] ?? [] : [];
  const busy = streamingTurnId !== null;
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
    if (!activeQuestion) return;
    const answers: UserQuestionAnswerItem[] = activeQuestion.questions.map((q) => {
      const selected = questionSelected[q.id] ?? [];
      return { id: q.id, selected };
    });
    const reqId = activeQuestion.reqId;
    setActiveQuestion(null);
    setQuestionSelected({});
    await window.todoList.aiUserQuestion.answer(reqId, answers);
  };
  const dismissQuestion = async (): Promise<void> => {
    if (!activeQuestion) return;
    const reqId = activeQuestion.reqId;
    setActiveQuestion(null);
    setQuestionSelected({});
    // Empty answers[] is rejected by the schema — the close button
    // explicitly cancels the request by sending an empty answer array,
    // which main treats as "user backed out".
    await window.todoList.aiUserQuestion.answer(reqId, []);
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
  const runSubmit = async (override?: { prompt: string; images: { name: string; mime: string; dataUrl: string }[] }): Promise<void> => {
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

    // Wrap the user's literal description in a clear "create a task"
    // instruction so the AI correctly interprets the Composer modal as a
    // capture surface (not a free-form chat). The user prompt stays
    // verbatim at the end so the model can ground its decisions in the
    // exact wording.
    const SYSTEM_INSTRUCTION =
      '[系统提示：用户通过"新建任务"界面提交了下面的描述，请使用 todo.create 工具创建一个新的 TODO 任务。' +
      'priority 根据紧迫程度判断（无/低/中/高）；status 默认 next（未完成），除非用户明确说"进行中"、"已完成"、"已取消"、"阻塞中"等。' +
      '如果描述包含截止日期（"明天"、"下周三"、"12-25" 等），解析为 unix 毫秒并填入 dueAt。' +
      '提取相关 tags。如果描述较长，第一行或核心动词短语作为 title。' +
      '创建完成后简短回复用户：任务名、优先级，截止日期（如有），不要重复整段描述。]\n\n';
    const wirePrompt = override
      ? `${SYSTEM_INSTRUCTION}[用户的描述]:\n${prompt}`
      : prompt;

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

    let finalWire = wirePrompt;
    if (attached.length > 0) {
      const blocks = attached.map((a) => {
        const header = `[attached: ${a.name} (${a.mime}, ${a.size} 字节)]`;
        return `${header}\n${a.text}`;
      });
      finalWire = `${wirePrompt}\n\n---\n\n${blocks.join('\n\n---\n\n')}`;
    }

    const priorTurns = (turnsByConv[convId] ?? [])
      .filter((t) => t.status === 'done' && t.assistant)
      .flatMap((t) => [
        { role: 'user' as const, content: t.user },
        { role: 'assistant' as const, content: t.assistant },
      ]);

    const id = crypto.randomUUID();
    setTurnsByConv((prev) => ({
      ...prev,
      [convId!]: [
        ...(prev[convId!] ?? []),
        // Display the user's literal prompt in the bubble, NOT the wrapped
        // system-instruction version — the user should see exactly what
        // they typed.
        { id, user: prompt, reasoning: '', assistant: '', tools: [], blocks: [], status: 'streaming', attached: attached.length > 0 ? attached : undefined },
      ],
    }));
    if (!override) {
      setInput('');
      clear();
    }
    setStreamingConvId(convId);
    setStreamingTurnId(id);
    const res = await window.todoList.ai.ask({ prompt: finalWire, conversationId: convId, invocationId: id, history: priorTurns, tools: undefined });
    if (!res.ok) {
      setTurnsByConv((prev) => {
        const list = prev[convId!] ?? [];
        return {
          ...prev,
          [convId!]: list.map((t) =>
            t.id === id ? { ...t, status: 'error', error: res.message ?? 'AI 调用失败' } : t,
          ),
        };
      });
    }
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
      void runSubmit({ prompt: detail.prompt, images: detail.images });
    };
    window.addEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    return () => window.removeEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    // runSubmit closes over currentId / streamingTurnId / etc.; the listener
    // picks up the latest closure on each event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, turnsByConv, streamingConvId, streamingTurnId]);

  return (
    <div className="aipane">
      {/* Minimal topbar — AI brand on the left, [+ new] and [🗂 history]
          on the right. The conversation title lives INSIDE the content area
          as a sticky heading, so the topbar doesn't compete for space. */}
      <header className="aipane__header">
        <div className="aipane__brand">
          <span className="aipane__brand-glyph" aria-hidden="true">
            <IconSparkle size={14} />
          </span>
          <span className="aipane__brand-text">AI 助手</span>
        </div>
        <div className="aipane__actions">
          <button
            type="button"
            className="icon-btn aipane__new-btn"
            onClick={() => void createConversation()}
            title="新建对话"
            aria-label="新建对话"
          >
            <IconPlus />
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
        </div>
      </header>

      <div className="aipane__body" role="log" aria-live="polite" ref={scrollRef}>
        {bootError && (
          <div className="aipane__empty aipane__empty--error">
            <IconWarn size={14} /> 会话列表加载失败：{bootError}
          </div>
        )}
        {/* The conversation title + current-question banner are wrapped in a
            single sticky header so they move as one unit. Previously both
            were individually sticky at top:0 — the taller current-question
            banner overlapped the title and its text bled into the title
            band ("content penetrates the title"). One shared sticky context
            with an opaque full-bleed background also guarantees scrolling
            messages can't show through the header. */}
        <div className="aipane__sticky-head" ref={stickyHeadRef}>
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

          {/* Scroll-tracked "current question" pin. This is an OVERLAY
              (absolute, child of the sticky header) rather than a flow
              element so that showing/hiding it never shifts the message
              stream the user is reading — it floats just below the title,
              covering the top sliver of the answer currently in view, and
              shows the question that has just scrolled out of sight.
              Styled like a user bubble (right-aligned, accent) so it reads
              as "the user's own question, kept in view". Rendered ONLY
              while a user question has scrolled out of view — the instant
              the original bubble is visible it isn't pinned, so the user
              never sees the same question twice. */}
          {!bootError && activeQuestionTurn && (
            <div
              className="aipane__currentq-overlay"
              aria-hidden="false"
              style={{ transform: `translateY(${pinTranslateY}px)` }}
            >
              <div className="aipane__currentq-pin bubble bubble--user" role="status" aria-label="当前问题">
                <span className="aipane__currentq-text">
                  {activeQuestionTurn.user}
                  {activeQuestionTurn.attached && activeQuestionTurn.attached.length > 0 && (
                    <span className="aipane__currentq-attach">
                      {' '}<IconAttach size={11} /> {activeQuestionTurn.attached.length} 个附件
                    </span>
                  )}
                </span>
                {busy && activeQuestionTurn.id === streamingTurnId && (
                  <span className="aipane__currentq-status" aria-live="polite">生成中…</span>
                )}
              </div>
            </div>
          )}
        </div>

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

      {/* Unified composer: ONE card holding + button (left, embedded),
          textarea (middle, flex-grows + autosizes), and Send/Stop (right).
          Attachment chips float ABOVE the card so they don't eat vertical
          space when empty. */}
      <div className="aipane__composer">
        {attachments.length > 0 && (
          <div className="aipane__attach-row" role="list" aria-label="已附加的文件">
            {attachments.map((a) => (
              <span key={a.path} className="aipane__attach-chip" role="listitem" title={`${a.path}\n${a.mime} · ${a.size} 字节`}>
                <span className="aipane__attach-chip-icon" aria-hidden="true"><IconAttach size={11} /></span>
                <span className="aipane__attach-chip-name">{a.name}</span>
                <button
                  type="button"
                  className="aipane__attach-chip-x"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={`移除 ${a.name}`}
                  title="移除"
                >
                  <IconClose size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="aipane__composer-card">
          <button
            type="button"
            className="aipane__attach-btn"
            onClick={() => void pickAttachment()}
            title="附加本地文件"
            aria-label="附加本地文件"
          >
            <IconPlus size={14} />
          </button>
          <textarea
            ref={textareaRef}
            aria-label="向 AI 提问"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void runSubmit();
                return;
              }
              if (e.key === 'Escape' && busy) {
                e.preventDefault();
                void stop();
              }
            }}
            placeholder={current ? '输入问题，回车发送…（Shift+Enter 换行，Esc 停止）' : '输入第一条问题，回车即创建对话…'}
            rows={1}
            className="aipane__input"
          />
          {busy ? (
            <button
              type="button"
              className="aipane__stop"
              onClick={() => void stop()}
              title="停止生成（Esc）"
              aria-label="停止生成"
            >
              <IconStop size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary aipane__send"
              onClick={() => void runSubmit()}
              disabled={!input.trim()}
              title={current ? '发送（Enter）' : '发送并创建对话'}
              aria-label="发送"
            >
              <IconSend size={14} />
            </button>
          )}
        </div>
      </div>

      {/* HITL cards — overlay the chat when DSH asks the user a structured
          question or requests binary approval. The card occupies its own
          row above the composer so the user sees it without scrolling. */}
      {activeQuestion && (
        <UserQuestionCard
          request={activeQuestion}
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
          onDismiss={() => void dismissQuestion()}
        />
      )}
      {activeApproval && (
        <UserApprovalCard
          request={activeApproval}
          onAllow={() => void submitApproval('allow-once')}
          onReject={() => void submitApproval('reject')}
        />
      )}
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
    return {
      id: crypto.randomUUID(),
      user: h.text ?? '',
      reasoning: '',
      assistant: '',
      tools: [],
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
    return {
      id: crypto.randomUUID(),
      user: '',
      reasoning,
      assistant: text,
      tools: [],
      blocks,
      status: 'done',
    };
  }
  // tool — synthesise a stable callId because the historical record does
  // not carry one (it lives in DSH's session stream, not in the persisted
  // JSONL). The card name + args act as a tie-breaker so reloading the
  // same history produces the same React key.
  const argsKey = (() => {
    try { return JSON.stringify(h.args ?? null); } catch { return ''; }
  })();
  return {
    id: crypto.randomUUID(),
    user: '',
    reasoning: '',
    assistant: '',
    tools: [{ name: h.name ?? '', args: h.args, result: h.ok ? h.data : h.error, ok: h.ok ?? false }],
    blocks: [{
      kind: 'tool-call',
      callId: `hist-${h.name ?? 'tool'}-${argsKey}`,
      name: h.name ?? '',
      args: h.args,
      result: h.ok ? h.data : h.error,
      ok: h.ok ?? false,
    }],
    status: 'done',
  };
}

const TurnView: React.FC<{ turn: Turn }> = ({ turn }) => {
  const { blocks, status } = turn;
  const streaming = status === 'streaming';
  // Last reasoning block — only this one runs the sweep while streaming
  // and the answer has not started yet. Earlier reasoning blocks sit
  // static so the model can't fake a "live" sweep on settled text.
  const lastReasoningIdx = blocks.reduce(
    (acc, b, i) => (b.kind === 'reasoning' ? i : acc), -1
  );
  const hasAnswer = blocks.some((b) => b.kind === 'text');
  const lastIdx = blocks.length - 1;
  // Pre-thinking chip: shown only while streaming and no block has landed
  // yet. Once the first reasoning / tool-call / text event arrives, the
  // block itself takes over with its own header label.
  const thinking = streaming && blocks.length === 0;
  return (
    <div className="turn">
      {turn.attached && turn.attached.length > 0 && (
        <div className="turn__attachments" aria-label="已附加的文件">
          {turn.attached.map((a) => (
            <span key={a.path} className="turn__attach-chip" title={`${a.path}\n${a.mime} · ${a.size} 字节`}>
              <span aria-hidden="true"><IconAttach size={11} /></span> {a.name}
            </span>
          ))}
        </div>
      )}
      {turn.user && (
        <div className="bubble bubble--user" data-user-q data-turn-id={turn.id}>
          {turn.user}
        </div>
      )}
      {/* Sibling rows in event order — reasoning ↔ tool-call ↔ text. Each
          row knows whether it's the active one so only the live one runs
          the sweep; earlier rows sit static under their disclosure header. */}
      {blocks.map((block, i) => {
        if (block.kind === 'reasoning') {
          const running = streaming && i === lastReasoningIdx && !hasAnswer;
          return <ReasoningRow key={`r-${i}`} text={block.text} running={running} />;
        }
        if (block.kind === 'tool-call') {
          const running = streaming && i === lastIdx;
          return (
            <ToolCallRow
              key={block.callId}
              card={{ name: block.name, args: block.args, result: block.result, ok: block.ok }}
              running={running}
            />
          );
        }
        // text
        return (
          <div key={`t-${i}`} className="bubble bubble--assistant">
            <Markdown text={block.text} streaming={streaming} />
          </div>
        );
      })}
      {thinking && <div className="aipane__thinking"><span className="aipane__dot" />思考中…</div>}
      {status === 'error' && (
        <div className="bubble bubble--error"><IconWarn size={14} /> {turn.error}</div>
      )}
    </div>
  );
};

/** One reasoning block, rendered as a DisclosureRow aligned with DeepSeek's
 *  ReasoningRow (see deepseek-harness/packages/client/ui-conversation/src/
 *  client/chat/ReasoningRow.tsx). Defaults to collapsed; the running flag
 *  forces open + running sweep and switches the title to "思考中…". Once
 *  running clears the user's manual open/closed state takes over. */
const ReasoningRow: React.FC<{ text: string; running: boolean }> = ({ text, running }) => {
  const [userOpen, setUserOpen] = useState(false);
  const open = running || userOpen;
  const title = running ? '思考中…' : '思考过程';
  // First non-empty line, truncated — visible in the collapsed header so
  // the user has a hint without expanding. While running this re-derives
  // per render so the trailing summary follows the live text.
  const summary = (() => {
    const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
    if (!line) return '';
    return line.length > 60 ? line.slice(0, 60) + '…' : line;
  })();
  return (
    <div className="reasoning-row" data-state={running ? 'running' : 'ok'}>
      <DisclosureRow
        icon={<IconThink size={14} />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setUserOpen((o) => !o)}
        collapsedContent={
          summary ? (
            <>
              <span className="reasoning-row__sep" aria-hidden />
              <span className="reasoning-row__summary">{summary}</span>
            </>
          ) : undefined
        }
      >
        <div className="reasoning-row__body">
          <Markdown text={text} streaming={running} />
        </div>
      </DisclosureRow>
    </div>
  );
};

/** One tool-call block, rendered as a DisclosureRow aligned with DeepSeek's
 *  ToolRow single-line-summary pattern (see deepseek-harness/packages/
 *  client/ui-tool/src/client/tool/components/ToolRow.tsx). Defaults to
 *  collapsed; never auto-opens — the user inspects args/result on demand.
 *  Running sweep only while streaming AND the block is the latest block. */
const ToolCallRow: React.FC<{
  card: { name: string; args?: unknown; result?: unknown; ok: boolean };
  running: boolean;
}> = ({ card, running }) => {
  const [open, setOpen] = useState(false);
  const argsText = formatValue(card.args);
  const resultText = formatValue(card.result);
  const state = running ? 'running' : card.ok ? 'ok' : 'error';
  // Collapsed summary: a one-line preview of the args. Falls back to the
  // tool name when args are empty/absent.
  const argsFirstLine = argsText.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  const summary = (argsFirstLine && argsFirstLine.length > 0
    ? argsFirstLine.length > 60 ? argsFirstLine.slice(0, 60) + '…' : argsFirstLine
    : card.name);
  return (
    <div className={`tool-call-row${card.ok ? '' : ' tool-call-row--error'}`} data-state={state}>
      <DisclosureRow
        icon={card.ok ? <IconTool size={14} /> : <IconWarn size={14} />}
        title={card.name || 'tool'}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((o) => !o)}
        collapsedContent={
          summary ? (
            <>
              <span className="tool-call-row__sep" aria-hidden />
              <span className="tool-call-row__summary">{summary}</span>
            </>
          ) : undefined
        }
      >
        {(argsText || resultText) && (
          <div className="tool-call-row__body">
            {argsText && (
              <div className="tool-call-row__section">
                <div className="tool-call-row__label">参数</div>
                <pre className="tool-call-row__pre">{argsText}</pre>
              </div>
            )}
            {resultText && (
              <div className="tool-call-row__section">
                <div className="tool-call-row__label">{card.ok ? '结果' : '错误'}</div>
                <pre className="tool-call-row__pre">{resultText}</pre>
              </div>
            )}
          </div>
        )}
      </DisclosureRow>
    </div>
  );
};

/** Pretty-print a tool arg/result value for the card body. */
function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    // The model's args arrive as a raw JSON string; try to pretty-print it.
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  // DSH tool results are ContentBlock[]; extract text when possible.
  if (Array.isArray(v)) {
    const texts = v
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '');
    if (texts.length === v.length && texts.length > 0) return texts.join('');
    return JSON.stringify(v, null, 2);
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ===== HITL answerer cards =====
//
// `aiUserQuestion.answer(reqId, answers)` rejects `answers.length === 0`;
// that's why the close button on the QuestionCard goes through `dismissQuestion`
// (which sends an explicit empty-answer payload to signal "user backed out").
// The ApprovalCard's reject button posts a `'reject'` decision which is a
// valid main-side payload (no length check).

const UserQuestionCard: React.FC<{
  request: ActiveQuestion;
  selected: Record<string, string[]>;
  onToggle: (qid: string, label: string, multi: boolean) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}> = ({ request, selected, onToggle, onSubmit, onDismiss }) => {
  // Submit is enabled only when every question has at least one selection
  // (or has zero options to pick — auto-confirm in that case).
  const ready = request.questions.every(
    (q) => (q.options && q.options.length > 0 ? (selected[q.id]?.length ?? 0) > 0 : true),
  );
  return (
    <div className="aipane__hitl aipane__hitl--question" role="dialog" aria-modal="false" aria-label="AI 询问">
      <div className="aipane__hitl-head">
        <Pill className="aipane__hitl-pill">需要回答</Pill>
        <span className="aipane__hitl-title">AI 需要你的输入</span>
        <button
          type="button"
          className="icon-btn aipane__hitl-close"
          onClick={onDismiss}
          aria-label="关闭"
          title="关闭（取消）"
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="aipane__hitl-body">
        {request.questions.map((q) => (
          <div key={q.id} className="aipane__hitl-question">
            <div className="aipane__hitl-q-label">{q.question}</div>
            {q.detail && <div className="aipane__hitl-q-detail">{q.detail}</div>}
            {q.options && q.options.length > 0 && (
              <div className="aipane__hitl-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((opt) => {
                  const cur = selected[q.id] ?? [];
                  const on = cur.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      className={`aipane__hitl-opt${on ? ' is-on' : ''}`}
                      onClick={() => onToggle(q.id, opt.label, q.multiSelect ?? false)}
                    >
                      <span className="aipane__hitl-opt-glyph" aria-hidden="true">{on ? '✓' : ''}</span>
                      <span className="aipane__hitl-opt-label">{opt.label}</span>
                      {opt.description && <span className="aipane__hitl-opt-desc">{opt.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="aipane__hitl-actions">
        <Button variant="ghost" onClick={onDismiss}>取消</Button>
        <Button variant="primary" onClick={onSubmit} disabled={!ready}>提交答案</Button>
      </div>
    </div>
  );
};

const UserApprovalCard: React.FC<{
  request: ActiveApproval;
  onAllow: () => void;
  onReject: () => void;
}> = ({ request, onAllow, onReject }) => (
  <div className="aipane__hitl aipane__hitl--approval" role="dialog" aria-modal="false" aria-label="AI 请求授权">
    <div className="aipane__hitl-head">
      <Pill className="aipane__hitl-pill aipane__hitl-pill--warn">需要授权</Pill>
      <span className="aipane__hitl-title">AI 想要调用 {request.toolName || '敏感操作'}</span>
    </div>
    <div className="aipane__hitl-body">
      <div className="aipane__hitl-q-detail">{request.reason}</div>
      {request.preview && (
        <pre className="aipane__hitl-preview">{request.preview}</pre>
      )}
    </div>
    <div className="aipane__hitl-actions">
      <Button variant="ghost" onClick={onReject}>拒绝</Button>
      <Button variant="primary" onClick={onAllow}>允许一次</Button>
    </div>
  </div>
);