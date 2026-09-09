// AI pane — chat-style conversation with rich rendering. Rendered inside the
// resident right AIPanel; designed for a ~380px column.
//
// Layout (L5 redesign):
//   ┌─ header (minimal): [🗂 history]  [＋ new]                ┐
//   ├─ content ───────────────────────────────────────────────┤
//   │  # 当前对话标题  (big sticky heading)                    │
//   │  ┌─ 当前问题 ────────────────────────────────────────┐  │  ← sticky banner
//   │  │ "用户问的问题"                                      │  │
//   │  └────────────────────────────────────────────────────┘  │
//   │  [message turn 1]                                       │
//   │  [message turn 2]                                       │
//   │  ...                                                   │
//   ├─ composer (unified input box) ───────────────────────────┤
//   │  + │  [textarea, multi-line, autosize]      [Send/Stop] │
//   └────────────────────────────────────────────────────────┘
//
// Why these changes:
// - 历史: collapsed behind ONE icon (🗂) so the header doesn't compete with
//   the message area for horizontal space.
// - 当前对话标题: shown as a sticky heading INSIDE the content area so the
//   user always sees what thread they're reading (the previous header was
//   dominated by the conversation-switcher buttons).
// - 悬浮显示当前用户问题: the most recent user message is rendered as a
//   sticky banner just below the title, so even after scrolling deep into
//   the history the user can see what was asked.
// - 统一输入框: composer is one card with the + icon embedded on the left
//   and the Send/Stop button on the right. Previously the file picker was a
//   separate left-of-textarea button, which made the affordance feel split.

import React, { useEffect, useRef, useState } from 'react';
import { useAiStream } from '../hooks/useThihyApi';
import { useDataVersion } from '../data-bus';
import { Markdown } from '../components/Markdown';
import type { AITokenEvent, AIToolCallEvent, AIReasoningEvent, AIStreamEvent } from '../../shared/ai-types';
import { AI_SUBMIT_EVENT, type ExternalAiSubmitDetail } from '../components/Composer';

interface ToolCard {
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
}

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
  // sidebar immediately. We also reuse this for archive/unarchive/delete
  // changes done by the AI tools (the tool result scope covers it now too).
  const convVersion = useDataVersion(['conversations']);

  // L5: history is collapsed behind ONE icon (🗂). That single button opens
  // a dropdown that holds: a search/filter box, the full conversation list,
  // a toggle for showing archived, and a "new conversation" entry. The
  // rename / archive / delete actions for the CURRENT conversation moved
  // into the per-row ⋯ on each list entry (or right-click), so the topbar
  // doesn't need its own actions menu.
  const [showHistory, setShowHistory] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState<Set<string>>(new Set());
  const [bootError, setBootError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // L3-H: search/filter for the history dropdown. Only matches by title
  // (not message body — that'd need to load every conversation's history
  // to filter, which is wasteful). Cleared on dropdown close so the next
  // open starts from the full list.
  const [switcherQuery, setSwitcherQuery] = useState('');
  // Per-row actions menu in the history dropdown. Only one row can have it
  // open at a time (clicking another row's ⋯ closes the previous one).
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  const historyRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Files the user picked via the composer's + button. We read them as
  // text in main (app.pickFile), so each entry carries the inlined text
  // body; the path / name are kept so the prompt can mention which file
  // the text came from and so the chip can show a meaningful label.
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);

  // Initial load: fetch the conversation list. If non-empty, pick the most
  // recent as current. If empty, leave currentId=null and show the empty
  // state — the user starts typing, and submit() allocates the first
  // conversation when they press Enter.
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await window.thihy.conversation.list({ includeArchived: showArchived });
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
    // currentId intentionally NOT in deps — this is the initial-fetch effect.
    // convVersion is bumped by main on data-changed {scope:'conversations'}
    // (DSH session-title rename, AI tool rename/archive/delete) — that's the
    // signal to re-fetch the list so the header + sidebar reflect the new
    // titles / archived state without waiting for the user to navigate.
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
  // open starts from the full list (filter state would otherwise survive
  // and confuse the next session).
  useEffect(() => {
    if (showHistory) {
      // Focus on next tick — the input isn't in the DOM until React renders
      // the dropdown div.
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
      const res = await window.thihy.conversation.history(currentId);
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
  useEffect(() => {
    if (!streamingTurnId || !streamingConvId) return;
    const mine = events.filter((e) => e.invocationId === streamingTurnId);
    if (mine.length === 0) return;
    const tokens = mine.filter((e): e is AITokenEvent => e.type === 'token');
    const reasoning = mine.filter((e): e is AIReasoningEvent => e.type === 'reasoning');
    const calls = mine.filter((e): e is AIToolCallEvent => e.type === 'toolCall');
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
                reasoning: reasoning.map((r) => r.text).join(''),
                assistant: tokens.map((tk) => tk.token).join(''),
                tools: calls.map((c) => ({ name: c.toolName, args: c.args, result: c.result, ok: c.ok })),
                status: errEvt ? 'error' : done ? 'done' : 'streaming',
                error: errEvt?.message,
              },
        ),
      };
    });
  }, [events, streamingConvId, streamingTurnId]);

  // Keep the latest message in view while streaming or switching.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnsByConv, currentId]);

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
  // The "current question" is the most recent user turn in this conversation,
  // whether it's the in-flight one or the last completed one. The sticky
  // banner surfaces it so the user always knows what they're waiting on /
  // just got an answer to, even after scrolling deep into the history.
  const lastUserTurn: Turn | null = (() => {
    for (let i = currentTurns.length - 1; i >= 0; i--) {
      if (currentTurns[i]!.user) return currentTurns[i]!;
    }
    return null;
  })();
  // L3-H: case-insensitive substring filter on title. Empty query = full
  // list. We don't try to be smarter (fuzzy, token-aware) — the list is
  // short enough that an exact substring match is enough to land on the
  // right row in 1-2 keystrokes. Matches against the title only (not
  // archived flag) so an archived conversation whose title matches is
  // still surfaced; the archived tag in the row shows the state.
  const filteredConversations: ConversationRow[] = switcherQuery
    ? conversations.filter((c) => c.title.toLowerCase().includes(switcherQuery.toLowerCase()))
    : conversations;

  const refreshList = async (): Promise<void> => {
    const res = await window.thihy.conversation.list({ includeArchived: showArchived });
    if (res.ok) setConversations(res.data.conversations);
  };

  const createConversation = async (): Promise<void> => {
    const r = await window.thihy.conversation.create();
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
    const r = await window.thihy.app.pickFile({ maxBytes: 256 * 1024 });
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
      // text is typed optional in the IPC schema, but main only returns
      // !canceled for files that passed the looksLikeText gate — guard
      // against the (impossible) empty case rather than trust the narrowing.
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
    const r = await window.thihy.conversation.rename(current.id, next);
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
      ? await window.thihy.conversation.unarchive(id)
      : await window.thihy.conversation.archive(id);
    setRowMenuId(null);
    if (!r.ok) return;
    // If the just-archived conversation was current, pick another.
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
    const confirm = await window.thihy.conversation.confirmDelete(id, row.title);
    if (!confirm.ok || !confirm.data.confirmed) return;
    await window.thihy.conversation.delete(id);
    // Drop its turns locally and pick another.
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
  // because the streaming turn remains in turnsByConv (its status flips to
  // 'done' once the cancel-issued done/error event arrives). The button is
  // a normal <button> — the user can also press Esc while focused on the
  // composer to stop (wired below).
  const stop = async (): Promise<void> => {
    if (!streamingConvId) return;
    const conv = streamingConvId;
    const inv = streamingTurnId ?? undefined;
    // Optimistic UI: clear streaming state so the Send button re-enables.
    // The runtime's `done` event will still arrive and turn the turn to
    // 'done' with whatever partial text streamed before cancel.
    setStreamingConvId(null);
    setStreamingTurnId(null);
    await window.thihy.ai.cancel(conv, inv);
    void refreshList();
  };

  // Submit pipeline shared by the inline composer button AND the Composer
  // modal (which dispatches a window event). Takes an optional override so
  // the Composer path can supply its own prompt + image attachments without
  // having to populate the textarea first (the user expects the Composer
  // modal to close immediately and the AI pane to take over from there).
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
        // For the chip's "size" display we approximate from the data URL
        // length (base64 carries 4 chars per 3 bytes). It's a label —
        // exact byte count isn't important.
        size: Math.floor((img.dataUrl.length * 3) / 4),
        // Stash the data URL in the `text` field so the AIPane's existing
        // wire-prompt builder can inlude it as image markdown without a
        // second code path. main never sees this; only this renderer
        // uses it for prompt assembly.
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

    // Make sure we have a conversation to write to. If the user has zero
    // conversations, allocating on first send keeps the empty state lightweight
    // (no auto-created empty thread cluttering the list) while still landing
    // them straight into a real chat the moment they press Enter.
    let convId = currentId;
    if (!convId) {
      const r = await window.thihy.conversation.create();
      if (!r.ok) return;
      convId = r.data.conversation.id;
      setConversations((prev) => [r.data.conversation, ...prev]);
      setTurnsByConv((prev) => ({ ...prev, [convId!]: [] }));
      setHistoryLoaded((prev) => new Set(prev).add(convId!));
      setCurrentId(convId);
    }

    // Snapshot attachments and clear them optimistically so the chip row
    // disappears while the turn is in flight (avoids the user double-sending
    // the same content if they panic-hit Enter).
    if (!override) setAttachments([]);

    // Build the wire prompt: the user's text verbatim, followed by each
    // attachment's text body in a clearly-labeled fenced block. The visible
    // bubble keeps the user's literal prompt — the chip row above tells them
    // which files were inlined — so they can audit what was actually sent.
    let finalWire = wirePrompt;
    if (attached.length > 0) {
      const blocks = attached.map((a) => {
        const header = `[attached: ${a.name} (${a.mime}, ${a.size} 字节)]`;
        return `${header}\n${a.text}`;
      });
      finalWire = `${wirePrompt}\n\n---\n\n${blocks.join('\n\n---\n\n')}`;
    }

    // Snapshot completed prior turns as multi-turn context for the model.
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
        // they typed. The system wrapper is hidden from the bubble.
        { id, user: prompt, reasoning: '', assistant: '', tools: [], status: 'streaming', attached: attached.length > 0 ? attached : undefined },
      ],
    }));
    if (!override) {
      setInput('');
      clear();
    }
    setStreamingConvId(convId);
    setStreamingTurnId(id);
    const res = await window.thihy.ai.ask({ prompt: finalWire, conversationId: convId, invocationId: id, history: priorTurns, tools: undefined });
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
    // Refresh list so the just-touched conversation bubbles to the top.
    void refreshList();
  };

  // The Composer modal (center "新建任务" surface) dispatches this event
  // when the user presses Enter. We pick it up here and route it through
  // the same submit pipeline, so the user's text + images end up in the
  // AI's prompt and the model creates the task via its todo.create tool.
  useEffect(() => {
    const onExternalSubmit = (e: Event): void => {
      const detail = (e as CustomEvent<ExternalAiSubmitDetail>).detail;
      if (!detail) return;
      void runSubmit({ prompt: detail.prompt, images: detail.images });
    };
    window.addEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    return () => window.removeEventListener(AI_SUBMIT_EVENT, onExternalSubmit);
    // runSubmit closes over currentId / streamingTurnId / etc.; the listener
    // picks up the latest closure on each event, which is what we want —
    // a stale closure would race the conversation id the user expects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, turnsByConv, streamingConvId, streamingTurnId]);

  return (
    <div className="aipane">
      {/* Minimal topbar. Per the L5 layout request:
            LEFT  : the "AI 助手" brand label so the panel always reads as
                    "this is the AI assistant" even when the conversation
                    title is in the content area.
            RIGHT : a [+ 新建] icon and the [🗂 历史] icon.
          The title itself moves out into the content area as a sticky
          heading below — the topbar stops competing for horizontal space. */}
      <header className="aipane__header">
        <div className="aipane__brand">
          <span className="aipane__brand-glyph" aria-hidden="true">✦</span>
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
            <span aria-hidden="true">＋</span>
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
              <span aria-hidden="true">🗂</span>
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
            ⚠ 会话列表加载失败：{bootError}
          </div>
        )}
        {/* The conversation title + current-question banner are wrapped in a
            single sticky header so they move as one unit. Previously both
            were individually sticky at top:0 — the taller current-question
            banner overlapped the title and its text bled into the title
            band ("content penetrates the title"). One shared sticky context
            with an opaque full-bleed background also guarantees scrolling
            messages can't show through the header. */}
        <div className="aipane__sticky-head">
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

        {/* Sticky "current question" banner. Surfaces the most recent user
            message so even after the user scrolls deep into the history to
            re-read an earlier answer, they always see what was actually
            asked. Hidden when there's no user message yet. */}
        {!bootError && lastUserTurn && (
          <div className="aipane__currentq" aria-label="当前问题">
            <span className="aipane__currentq-glyph" aria-hidden="true">❝</span>
            <span className="aipane__currentq-text">
              {lastUserTurn.user}
              {lastUserTurn.attached && lastUserTurn.attached.length > 0 && (
                <span className="aipane__currentq-attach">
                  {' '}📎 {lastUserTurn.attached.length} 个附件
                </span>
              )}
            </span>
            {busy && (
              <span className="aipane__currentq-status" aria-live="polite">生成中…</span>
            )}
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
                <span className="aipane__attach-chip-icon" aria-hidden="true">📎</span>
                <span className="aipane__attach-chip-name">{a.name}</span>
                <button
                  type="button"
                  className="aipane__attach-chip-x"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={`移除 ${a.name}`}
                  title="移除"
                >
                  ×
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
            ＋
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
              // L3-B: Esc while focused on the composer cancels the in-flight
              // turn. Skipped when nothing is in flight so Esc can still be
              // used normally (e.g. to clear the textarea in the future).
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
            // L3-B: ⏹ stops the in-flight turn. Distinct visual treatment
            // (danger-tone + stop glyph) so it doesn't read as a Send button
            // that happens to be disabled — the affordance is "abort", not
            // "wait". The textarea stays editable so the user can compose
            // the next prompt while the model winds down.
            <button
              type="button"
              className="aipane__stop"
              onClick={() => void stop()}
              title="停止生成（Esc）"
              aria-label="停止生成"
            >
              <span className="aipane__stop-glyph" aria-hidden="true">■</span>
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
              <span aria-hidden="true">➤</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  /** Inline rename helper: same flow as beginRename() but for a chosen row,
   *  not necessarily the currently-active conversation. */
  function beginRenameFor(c: ConversationRow): void {
    setRenameDraft(c.title);
    setRenaming(true);
    // Switch to it first so commitRename() targets the right id.
    setCurrentId(c.id);
    setShowHistory(false);
    setRowMenuId(null);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }
};

/** Convert a HistoryTurn (from JSONL decode) into the renderer's Turn shape. */
function historyToTurn(h: HistoryTurnLike): Turn {
  if (h.type === 'user') {
    return { id: crypto.randomUUID(), user: h.text ?? '', reasoning: '', assistant: '', tools: [], status: 'done' };
  }
  if (h.type === 'assistant') {
    return {
      id: crypto.randomUUID(),
      user: '',
      reasoning: h.reasoning ?? '',
      assistant: h.text ?? '',
      tools: [],
      status: 'done',
    };
  }
  // tool
  return {
    id: crypto.randomUUID(),
    user: '',
    reasoning: '',
    assistant: '',
    tools: [{ name: h.name ?? '', args: h.args, result: h.ok ? h.data : h.error, ok: h.ok ?? false }],
    status: 'done',
  };
}

const TurnView: React.FC<{ turn: Turn }> = ({ turn }) => {
  const streaming = turn.status === 'streaming';
  const thinking = streaming && !turn.assistant && turn.tools.length === 0 && !turn.reasoning;
  return (
    <div className="turn">
      {turn.attached && turn.attached.length > 0 && (
        <div className="turn__attachments" aria-label="已附加的文件">
          {turn.attached.map((a) => (
            <span key={a.path} className="turn__attach-chip" title={`${a.path}\n${a.mime} · ${a.size} 字节`}>
              <span aria-hidden="true">📎</span> {a.name}
            </span>
          ))}
        </div>
      )}
      {turn.user && <div className="bubble bubble--user">{turn.user}</div>}
      {turn.reasoning && <ReasoningView text={turn.reasoning} streaming={streaming} />}
      {turn.tools.map((tc, i) => (
        <ToolCardView key={i} card={tc} />
      ))}
      {thinking && <div className="aipane__thinking"><span className="aipane__dot" />思考中…</div>}
      {turn.assistant && (
        <div className="bubble bubble--assistant">
          <Markdown text={streaming ? `${turn.assistant} ▍` : turn.assistant} />
        </div>
      )}
      {turn.status === 'error' && (
        <div className="bubble bubble--error">⚠ {turn.error}</div>
      )}
    </div>
  );
};

const ReasoningView: React.FC<{ text: string; streaming: boolean }> = ({ text, streaming }) => {
  // Collapsed by default — the reasoning is verbose; expand to inspect. While
  // streaming, show a live "思考中…" hint in the header so the user sees the
  // model is thinking even before any answer token lands.
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="reasoning__icon" aria-hidden="true">💭</span>
        <span className="reasoning__label">{streaming ? '思考中…' : '思考过程'}</span>
        <span className="reasoning__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="reasoning__body">
          <Markdown text={streaming ? `${text} ▍` : text} />
        </div>
      )}
    </div>
  );
};

const ToolCardView: React.FC<{ card: ToolCard }> = ({ card }) => {
  const [open, setOpen] = useState(false);
  const argsText = formatValue(card.args);
  const resultText = formatValue(card.result);
  return (
    <div className={`toolcard${card.ok ? '' : ' toolcard--error'}`}>
      <button type="button" className="toolcard__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="toolcard__icon" aria-hidden="true">{card.ok ? '🔧' : '⚠'}</span>
        <span className="toolcard__name">{card.name || 'tool'}</span>
        <span className="toolcard__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (argsText || resultText) && (
        <div className="toolcard__body">
          {argsText && (
            <div className="toolcard__section">
              <div className="toolcard__label">参数</div>
              <pre className="toolcard__pre">{argsText}</pre>
            </div>
          )}
          {resultText && (
            <div className="toolcard__section">
              <div className="toolcard__label">{card.ok ? '结果' : '错误'}</div>
              <pre className="toolcard__pre">{resultText}</pre>
            </div>
          )}
        </div>
      )}
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
