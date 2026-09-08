// AI pane — chat-style conversation with rich rendering. Rendered inside the
// resident right AIPanel; designed for a ~380px column.
//
// What makes this better than a plain text bubble:
// - assistant output renders as markdown (lists, code blocks, tables, links)
// - tool calls + their args/result show as inline cards so the user sees the
//   agent "acting", not just final prose
// - a thinking indicator before the first token + a streaming cursor while text
//   arrives
//
// L2 multi-conversation model:
// - The header has a conversation switcher (▼ 当前), a "+ 新对话" button, and
//   a per-conversation actions menu (⋯). Each user-controlled conversation
//   is a row in the `conversations` table; its full event log lives in the
//   dsh-session-persistence-jsonl backend, loaded on-demand when the user
//   switches back to it.
// - Each conversation keeps its own turns list in `turnsByConv` so switching
//   away and back preserves in-flight + completed turns for that thread.
// - Archived conversations are hidden by default; a menu toggle reveals them.

import React, { useEffect, useRef, useState } from 'react';
import { useAiStream } from '../hooks/useThihyApi';
import { useDataVersion } from '../data-bus';
import { Markdown } from '../components/Markdown';
import type { AITokenEvent, AIToolCallEvent, AIReasoningEvent, AIStreamEvent } from '../../shared/ai-types';

interface ToolCard {
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
}

/** A file the user picked via the composer's 📎 button. main reads the file
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

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState<Set<string>>(new Set());
  const [bootError, setBootError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // L3-H: search/filter for the switcher dropdown. Only matches by title
  // (not message body — that'd need to load every conversation's history
  // to filter, which is wasteful). Cleared on dropdown close so the next
  // open starts from the full list.
  const [switcherQuery, setSwitcherQuery] = useState('');

  const switcherRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const switcherSearchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Files the user picked via the composer's 📎 button. We read them as
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
      if (showSwitcher && switcherRef.current && !switcherRef.current.contains(t)) setShowSwitcher(false);
      if (showActions && actionsRef.current && !actionsRef.current.contains(t)) setShowActions(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showSwitcher, showActions]);

  // L3-H: when the switcher opens, focus the search input so the user can
  // type immediately. When it closes, clear the query so the next open
  // starts from the full list (filter state would otherwise survive and
  // confuse the next session).
  useEffect(() => {
    if (showSwitcher) {
      // Focus on next tick — the input isn't in the DOM until React renders
      // the dropdown div.
      const t = setTimeout(() => switcherSearchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setSwitcherQuery('');
    return;
  }, [showSwitcher]);

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

  const current = conversations.find((c) => c.id === currentId) ?? null;
  const currentTurns: Turn[] = currentId ? turnsByConv[currentId] ?? [] : [];
  const busy = streamingTurnId !== null;
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
    setShowSwitcher(false);
    setShowActions(false);
  };

  // Open the native file picker (main does dialog.showOpenDialog, reads the
  // file as utf-8 up to a small limit) and append the result to the chip
  // row above the textarea. Multi-pick is disabled — adding one file at a
  // time keeps the prompt length predictable; the user can keep clicking
  // 📎 to add more.
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
    setShowSwitcher(false);
    if (id === currentId) return;
    setCurrentId(id);
  };

  const beginRename = (): void => {
    if (!current) return;
    setRenameDraft(current.title);
    setRenaming(true);
    setShowActions(false);
    setTimeout(() => renameInputRef.current?.focus(), 0);
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

  const toggleArchive = async (): Promise<void> => {
    if (!current) return;
    const r = current.archived
      ? await window.thihy.conversation.unarchive(current.id)
      : await window.thihy.conversation.archive(current.id);
    setShowActions(false);
    if (!r.ok) return;
    // If the just-archived conversation was current, pick another.
    if (current.archived === false) {
      const next = conversations.find((c) => c.id !== current.id && !c.archived);
      setCurrentId(next?.id ?? null);
    }
    await refreshList();
  };

  const deleteCurrent = async (): Promise<void> => {
    if (!current) return;
    // L3-F: native themed confirm via dialog.showMessageBox (main). The
    // dialog title + message explain what "delete" actually does here
    // (row removal + JSONL kept on disk for later cleanup) so the user
    // isn't surprised by lingering on-disk logs.
    setShowActions(false);
    const confirm = await window.thihy.conversation.confirmDelete(current.id, current.title);
    if (!confirm.ok || !confirm.data.confirmed) return;
    await window.thihy.conversation.delete(current.id);
    // Drop its turns locally and pick another.
    setTurnsByConv((prev) => {
      const next = { ...prev };
      delete next[current.id];
      return next;
    });
    setHistoryLoaded((prev) => {
      const next = new Set(prev);
      next.delete(current.id);
      return next;
    });
    const remaining = conversations.filter((c) => c.id !== current.id);
    setConversations(remaining);
    setCurrentId(remaining[0]?.id ?? null);
  };

  const submit = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt) return;
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
    const attached = attachments;
    setAttachments([]);

    // Build the wire prompt: the user's text verbatim, followed by each
    // attachment's text body in a clearly-labeled fenced block. The visible
    // bubble keeps the user's literal prompt — the chip row above tells them
    // which files were inlined — so they can audit what was actually sent.
    let wirePrompt = prompt;
    if (attached.length > 0) {
      const blocks = attached.map((a) => {
        const header = `[attached: ${a.name} (${a.mime}, ${a.size} 字节)]`;
        return `${header}\n${a.text}`;
      });
      wirePrompt = `${prompt}\n\n---\n\n${blocks.join('\n\n---\n\n')}`;
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
        { id, user: prompt, reasoning: '', assistant: '', tools: [], status: 'streaming', attached: attached.length > 0 ? attached : undefined },
      ],
    }));
    setInput('');
    clear();
    setStreamingConvId(convId);
    setStreamingTurnId(id);
    const res = await window.thihy.ai.ask({ prompt: wirePrompt, conversationId: convId, invocationId: id, history: priorTurns, tools: undefined });
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

  return (
    <div className="aipane">
      <header className="aipane__header">
        <div className="aipane__title">
          <span className="aipane__glyph" aria-hidden="true">✦</span>
          <span>AI 助手</span>
        </div>
        <div className="aipane__meta" ref={switcherRef}>
          {renaming && current ? (
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
            // L3-E: split the switcher into two click targets. Clicking the
            // title text enters rename mode (the common-case one-click
            // affordance); clicking the caret still opens the switcher
            // dropdown. The 2-click rename (⋯ → 重命名) is preserved as a
            // keyboard / discoverability fallback via the actions menu.
            <div className="aipane__switcher-btn" data-disabled={conversations.length === 0 && !current}>
              <button
                type="button"
                className="aipane__switcher-title"
                onClick={() => { if (current) beginRename(); }}
                disabled={!current}
                title={current ? `重命名：${current.title}` : '选择对话'}
                aria-label={current ? `重命名对话：${current.title}` : '选择对话'}
              >
                {current?.title ?? '选择对话…'}
              </button>
              <button
                type="button"
                className="aipane__switcher-caret-btn"
                onClick={() => { setShowSwitcher((s) => !s); setShowActions(false); }}
                disabled={conversations.length === 0 && !current}
                title="切换对话"
                aria-label="切换对话"
                aria-haspopup="listbox"
                aria-expanded={showSwitcher}
              >
                <span aria-hidden="true">▾</span>
              </button>
            </div>
          )}
          {showSwitcher && (
            <div className="aipane__menu aipane__menu--left" role="listbox">
              {/* L3-H: search/filter input. Type to narrow the list by
                  title; matches are case-insensitive substring. Esc clears
                  the filter; Enter selects the first match (or no-op if
                  none). The search box is always present when the dropdown
                  is open — even with 0 conversations, so users have a hint
                  that filter is available. */}
              <div className="aipane__search">
                <input
                  ref={switcherSearchRef}
                  type="search"
                  className="aipane__search-input"
                  placeholder="搜索对话标题…"
                  value={switcherQuery}
                  onChange={(e) => setSwitcherQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      if (switcherQuery) setSwitcherQuery('');
                      else setShowSwitcher(false);
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
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === currentId}
                  className={`aipane__menu-item${c.id === currentId ? ' aipane__menu-item--active' : ''}`}
                  onClick={() => switchTo(c.id)}
                  title={c.title}
                >
                  {/* L3-J: two-line layout. Line 1 = title + tags;
                       line 2 = last message preview + count when known.
                       Tool turns don't drive the preview (last non-tool
                       turn is computed in main), so the preview reflects
                       actual conversation content the user typed/read. */}
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
              ))}
              <div className="aipane__menu-divider" />
              <button
                type="button"
                className="aipane__menu-item aipane__menu-item--toggle"
                onClick={() => { setShowSwitcher(false); setShowArchived((s) => !s); }}
              >
                {showArchived ? '隐藏已归档' : '显示已归档'}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="icon-btn aipane__newbtn"
          onClick={() => void createConversation()}
          title="新建对话"
          aria-label="新建对话"
        >
          +
        </button>

        <div className="aipane__actions" ref={actionsRef}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => { setShowActions((s) => !s); setShowSwitcher(false); }}
            disabled={!current}
            title="对话操作"
            aria-label="对话操作"
            aria-haspopup="menu"
            aria-expanded={showActions}
          >
            ⋯
          </button>
          {showActions && current && (
            <div className="aipane__menu aipane__menu--right" role="menu">
              <button type="button" className="aipane__menu-item" onClick={() => beginRename()}>重命名</button>
              <button type="button" className="aipane__menu-item" onClick={() => void toggleArchive()}>
                {current.archived ? '取消归档' : '归档'}
              </button>
              <div className="aipane__menu-divider" />
              <button type="button" className="aipane__menu-item aipane__menu-item--danger" onClick={() => void deleteCurrent()}>
                删除
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="aipane__body" role="log" aria-live="polite" ref={scrollRef}>
        {bootError && (
          <div className="aipane__empty aipane__empty--error">
            ⚠ 会话列表加载失败：{bootError}
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
        <div className="aipane__composer-row">
          <button
            type="button"
            className="aipane__attach-btn"
            onClick={() => void pickAttachment()}
            title="附加本地文件"
            aria-label="附加本地文件"
          >
            📎
          </button>
          <textarea
            aria-label="向 AI 提问"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
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
            rows={2}
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
              <span>停止</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary aipane__send"
              onClick={() => void submit()}
              disabled={!input.trim()}
              title={current ? '发送（Enter）' : '发送并创建对话'}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
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