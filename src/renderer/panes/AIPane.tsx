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
import { Markdown } from '../components/Markdown';
import type { AITokenEvent, AIToolCallEvent, AIReasoningEvent, AIStreamEvent } from '../../shared/ai-types';

interface ToolCard {
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
}

interface Turn {
  id: string;
  user: string;
  reasoning: string;
  assistant: string;
  tools: ToolCard[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

interface ConversationRow {
  id: string;
  title: string;
  updatedAt: number;
  archived: boolean;
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

export const AIPane: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
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

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState<Set<string>>(new Set());
  const [bootError, setBootError] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const switcherRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load: fetch the conversation list. If non-empty, pick the most
  // recent as current. If empty, leave currentId=null and show the empty
  // state — the user explicitly creates their first conversation.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

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
    const ok = window.confirm(`删除对话"${current.title}"？历史记录将一并移除。`);
    if (!ok) return;
    setShowActions(false);
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
    // Make sure we have a conversation to write to.
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
        { id, user: prompt, reasoning: '', assistant: '', tools: [], status: 'streaming' },
      ],
    }));
    setInput('');
    clear();
    setStreamingConvId(convId);
    setStreamingTurnId(id);
    const res = await window.thihy.ai.ask({ prompt, conversationId: convId, invocationId: id, history: priorTurns, tools: undefined });
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
              {conversations.length === 0 && (
                <div className="aipane__menu-empty">还没有对话</div>
              )}
              {conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === currentId}
                  className={`aipane__menu-item${c.id === currentId ? ' aipane__menu-item--active' : ''}`}
                  onClick={() => switchTo(c.id)}
                  title={c.title}
                >
                  <span className="aipane__menu-title">{c.title}</span>
                  {c.archived && <span className="aipane__menu-tag">已归档</span>}
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

        {onCollapse && (
          <button type="button" className="icon-btn" onClick={onCollapse} aria-label="收起" title="收起">
            ‹
          </button>
        )}
      </header>

      <div className="aipane__body" role="log" aria-live="polite" ref={scrollRef}>
        {bootError && (
          <div className="aipane__empty aipane__empty--error">
            ⚠ 会话列表加载失败：{bootError}
          </div>
        )}
        {!bootError && !current && conversations.length === 0 && (
          <div className="aipane__empty">
            <p>开始与 AI 助手对话：</p>
            <ul>
              <li>今天我应该先做什么？</li>
              <li>把第 3 条 TODO 拆成 3 个子任务</li>
              <li>总结这周所有高优完成情况</li>
            </ul>
            <p className="aipane__hint">点右上角 <strong>+</strong> 创建第一条对话</p>
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
          placeholder={current ? '输入问题，回车发送…（Shift+Enter 换行，Esc 停止）' : '先创建一条对话再发送'}
          rows={2}
          className="aipane__input"
          disabled={!current && conversations.length === 0}
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
            disabled={!input.trim() || !current}
          >
            发送
          </button>
        )}
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