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
// The backend streams AIStreamEvent (token / toolCall / done / error) over the
// 'ai:stream' channel; this hook re-derives the active turn from its events.

import React, { useEffect, useRef, useState } from 'react';
import { useAiStream, useModels } from '../hooks/useThihyApi';
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

export const AIPane: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
  const { events, clear } = useAiStream();
  const { models } = useModels();
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-derive the active turn from its stream events (cheap; events capped at 200).
  useEffect(() => {
    if (!activeId) return;
    const mine = events.filter((e) => e.invocationId === activeId);
    if (mine.length === 0) return;
    const tokens = mine.filter((e): e is AITokenEvent => e.type === 'token');
    const reasoning = mine.filter((e): e is AIReasoningEvent => e.type === 'reasoning');
    const calls = mine.filter((e): e is AIToolCallEvent => e.type === 'toolCall');
    const done = mine.some((e) => e.type === 'done');
    const errEvt = mine.find((e): e is Extract<AIStreamEvent, { type: 'error' }> => e.type === 'error');
    setTurns((prev) =>
      prev.map((t) =>
        t.id !== activeId
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
    );
  }, [events, activeId]);

  // Keep the latest message in view while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt) return;
    // Snapshot prior completed turns as multi-turn context for the model.
    const priorTurns = turns
      .filter((t) => t.status === 'done' && t.assistant)
      .flatMap((t) => [
        { role: 'user' as const, content: t.user },
        { role: 'assistant' as const, content: t.assistant },
      ]);
    const id = crypto.randomUUID();
    setTurns((prev) => [...prev, { id, user: prompt, reasoning: '', assistant: '', tools: [], status: 'streaming' }]);
    setInput('');
    clear();
    setActiveId(id);
    const res = await window.thihy.ai.ask({ prompt, invocationId: id, history: priorTurns, tools: undefined });
    if (!res.ok) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: 'error', error: res.message ?? 'AI 调用失败' } : t,
        ),
      );
    }
    setActiveId((cur) => (cur === id ? null : cur));
  };

  const busy = activeId !== null;

  return (
    <div className="aipane">
      <header className="aipane__header">
        <div className="aipane__title">
          <span className="aipane__glyph" aria-hidden="true">✦</span>
          <span>AI 助手</span>
        </div>
        <div className="aipane__meta">{models.join(', ') || '—'}</div>
        {onCollapse && (
          <button type="button" className="icon-btn" onClick={onCollapse} aria-label="收起" title="收起">
            ‹
          </button>
        )}
      </header>

      <div className="aipane__body" role="log" aria-live="polite" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="aipane__empty">
            <p>问任何关于 TODO 的问题：</p>
            <ul>
              <li>今天我应该先做什么？</li>
              <li>把第 3 条 TODO 拆成 3 个子任务</li>
              <li>总结这周所有高优完成情况</li>
            </ul>
          </div>
        ) : (
          turns.map((t) => <TurnView key={t.id} turn={t} />)
        )}
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
            }
          }}
          placeholder="输入问题，回车发送…（Shift+Enter 换行）"
          rows={2}
          className="aipane__input"
        />
        <button
          type="button"
          className="btn-primary aipane__send"
          onClick={() => void submit()}
          disabled={busy || !input.trim()}
        >
          {busy ? '生成中…' : '发送'}
        </button>
      </div>
    </div>
  );
};

const TurnView: React.FC<{ turn: Turn }> = ({ turn }) => {
  const streaming = turn.status === 'streaming';
  const thinking = streaming && !turn.assistant && turn.tools.length === 0 && !turn.reasoning;
  return (
    <div className="turn">
      <div className="bubble bubble--user">{turn.user}</div>
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
