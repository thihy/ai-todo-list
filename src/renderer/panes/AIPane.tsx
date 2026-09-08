// AI pane — chat-style conversation. Rendered inside the resident right
// AIPanel; designed for a ~380px column.

import React, { useEffect, useRef, useState } from 'react';
import { useAiStream, useModels } from '../hooks/useThihyApi';
import type { AITokenEvent } from '../../shared/ai-types';

export const AIPane: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
  const { events, clear } = useAiStream();
  const { models } = useModels();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [invocationId, setInvocationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Assemble assistant text from streamed tokens for the current invocation.
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (last.type === 'done' && last.invocationId === invocationId) {
      setHistory((h) => {
        const lastEntry = h[h.length - 1];
        if (lastEntry?.role === 'assistant') return h;
        return [...h, { role: 'assistant', text: '' }];
      });
    }
    setHistory((h) => {
      const next = [...h];
      const cur = next[next.length - 1];
      if (!cur || cur.role !== 'assistant') return next;
      const tokens = events.filter(
        (e): e is AITokenEvent => e.type === 'token' && e.invocationId === invocationId,
      );
      next[next.length - 1] = { ...cur, text: tokens.map((t) => t.token).join('') };
      return next;
    });
  }, [events, invocationId]);

  // Keep the latest message in view while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history]);

  const submit = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    // Snapshot prior turns (all complete user/assistant pairs from earlier
    // messages) so the model gets multi-turn context. The new user message +
    // empty assistant placeholder are appended to local history separately.
    const priorTurns = history.map((m) => ({ role: m.role, content: m.text }));
    setHistory((h) => [...h, { role: 'user', text: prompt }, { role: 'assistant', text: '' }]);
    setInput('');
    setBusy(true);
    clear();
    const id = crypto.randomUUID();
    setInvocationId(id);
    const res = await window.thihy.ai.ask({ prompt, invocationId: id, history: priorTurns, tools: undefined });
    if (!res.ok) {
      setHistory((h) => {
        const next = [...h];
        next[next.length - 1] = { role: 'assistant', text: `⚠ ${res.message ?? 'AI 调用失败'}` };
        return next;
      });
    }
    setBusy(false);
  };

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
        {history.length === 0 ? (
          <div className="aipane__empty">
            <p>问任何关于 TODO 的问题：</p>
            <ul>
              <li>今天我应该先做什么？</li>
              <li>把第 3 条 TODO 拆成 3 个子任务</li>
              <li>总结这周所有高优完成情况</li>
            </ul>
          </div>
        ) : (
          history.map((m, i) => <Bubble key={i} role={m.role} text={m.text} />)
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
          placeholder="输入问题，回车发送…"
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

const Bubble: React.FC<{ role: 'user' | 'assistant'; text: string }> = ({ role, text }) => (
  <div className={`bubble bubble--${role}`}>
    {text || (role === 'assistant' ? '▍' : '')}
  </div>
);
