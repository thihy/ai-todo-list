// foldHistory — pure function that converts a DSH session event log into
// a flat list of HistoryTurn entries. The shapes are notoriously fragile:
// user/message uses data.content (NOT data.message.content like the
// assistant variant), assistant/text comes from streaming chunks (the
// final assistant/message often has empty text), tool/call and tool/result
// pair by callId, etc. Pin these contracts with tests so a future DSH
// upgrade that changes serialization doesn't silently break the AIPane.

import { describe, it, expect } from 'vitest';
import { foldHistory } from '../../src/main/dsh/dsh-runtime';
import { encodeTaskCreationEnvelope } from '../../src/shared/task-creation';

/** Build a user/message event with the DSH shape used in the wild. */
function userMsg(text: string, id = 'u1') {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id } };
}
/** Build an assistant/chunk event for a text-delta. */
function textDelta(text: string) {
  return { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } };
}
/** Build an assistant/chunk event for a reasoning-delta. */
function reasoningDelta(text: string) {
  return { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } };
}
/** Build the final assistant/message event. The text blocks here are
 *  often empty in the real DSH log (the answer is in the chunks) — tests
 *  rely on this quirk to verify the chunk-wins path. */
function assistantMsg(contentBlocks: Array<{ type: string; text?: string }> = []) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: contentBlocks, source: { kind: 'assistant' } }, turn: 1, step: 1, usage: {} } };
}
/** Build a tool/call event. */
function toolCall(callId: string, name: string, args = '{}') {
  return { type: 'tool/call', data: { callId, name, arguments: args } };
}
/** Build a tool/result event. */
function toolResult(callId: string, ok = true, content: unknown = { ok: true }, meta?: unknown) {
  return {
    type: 'tool/result',
    data: {
      message: { source: { callId }, content: [{ isError: !ok, content: Array.isArray(content) ? content : [content] }] },
      ...(meta === undefined ? {} : { meta }),
    },
  };
}
/** Step boundary — flushes accumulated assistant text. */
function stepEnd() { return { type: 'step/end', data: {} }; }

describe('foldHistory', () => {
  it('returns empty for an empty log', () => {
    expect(foldHistory([])).toEqual([]);
  });

  it('emits one user turn when only a user message is in the log', () => {
    const turns = foldHistory([userMsg('只回答一个水果的名字')]);
    expect(turns).toEqual([{ type: 'user', text: '只回答一个水果的名字' }]);
  });

  it('concatenates multiple text blocks in one user/message event', () => {
    const ev = { type: 'user/message', data: { content: [{ type: 'text', text: '第一段 ' }, { type: 'text', text: '第二段' }], source: {}, role: 'user', id: 'u1' } };
    const turns = foldHistory([ev]);
    expect(turns[0]).toEqual({ type: 'user', text: '第一段 第二段' });
  });

  it('reconstructs assistant text from text-delta chunks (the L2-E bug)', () => {
    // This is the exact bug from the L2-E fix: the assistant/message
    // event has empty text blocks because DSH's chunks carry the
    // answer. foldHistory must aggregate the chunks.
    const events = [
      userMsg('水果'),
      textDelta('苹'),
      textDelta('果'),
      assistantMsg([]), // empty — DSH serialization quirk
      stepEnd(),
    ];
    const turns = foldHistory(events);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ type: 'user', text: '水果' });
    expect(turns[1]).toEqual({ type: 'assistant', text: '苹果' });
  });

  it('captures reasoning content as a separate field on the assistant turn', () => {
    const events = [
      userMsg('动物'),
      reasoningDelta('让我想想...'),
      reasoningDelta(' 哪个简单？'),
      textDelta('猫'),
      assistantMsg([{ type: 'reasoning', text: 'WONT WIN' }, { type: 'text', text: 'WONT WIN' }]),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    const assistant = turns.find((t) => t.type === 'assistant')!;
    expect(assistant.text).toBe('猫');
    expect(assistant.reasoning).toBe('让我想想... 哪个简单？');
  });

  it('falls back to assistant/message content when chunks are absent', () => {
    // Some very short responses skip streaming and emit the final event
    // directly. foldHistory should still produce a turn — by reading the
    // message.content blocks.
    const events = [
      userMsg('问候'),
      assistantMsg([{ type: 'text', text: '你好' }]),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({ type: 'assistant', text: '你好' });
  });

  it('pairs tool/call with tool/result by callId and emits one tool turn', () => {
    const events = [
      userMsg('查找'),
      toolCall('c1', 'todo.list', '{"status":"next"}'),
      toolResult('c1', true, [{ type: 'text', text: '[]' }]),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    const tools = turns.filter((t) => t.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'tool', name: 'todo.list', ok: true });
    expect((tools[0] as { args?: string }).args).toBe('{"status":"next"}');
  });

  it('preserves tool/result presentation meta for rich DSH cards', () => {
    const meta = {
      sources: [{ url: 'https://example.com', title: 'Example' }],
      truncated: false,
    };
    const turns = foldHistory([
      toolCall('web-1', 'web_search', '{"queries":["example"]}'),
      toolResult('web-1', true, [{ type: 'text', text: 'formatted model output' }], meta),
    ]);
    expect(turns).toContainEqual(expect.objectContaining({
      type: 'tool',
      name: 'web_search',
      presentationMeta: meta,
    }));
  });

  it('emits a tool turn with ok=false when no result follows', () => {
    const events = [
      userMsg('查找'),
      toolCall('c1', 'todo.list'),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    const tools = turns.filter((t) => t.type === 'tool');
    expect(tools).toHaveLength(1);
    // `missing-result` is NOT an automatic failure: ok=false paints the
    // neutral "结果未记录" pill, NOT the red error dot. Error string is
    // absent — the renderer surfaces the missing-result via the explicit
    // state field, not a fake error.
    expect(tools[0]).toMatchObject({
      type: 'tool',
      name: 'todo.list',
      ok: false,
      state: 'missing-result',
      error: undefined,
    });
  });

  it('emits a tool turn with ok=false and error content on error result', () => {
    const events = [
      userMsg('查找'),
      toolCall('c1', 'todo.get'),
      toolResult('c1', false, [{ type: 'text', text: 'not found' }]),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    const tool = turns.find((t) => t.type === 'tool')! as { type: 'tool'; ok: boolean; error?: string };
    expect(tool.ok).toBe(false);
    expect(tool.error).toContain('not found');
  });

  it('flushes assistant text at every tool call boundary', () => {
    // Text → tool call → text → step_end. Without the per-tool-call flush,
    // the second text would merge into the first assistant turn and the
    // tool would be invisible. With it, you get: assistant(text1),
    // tool, assistant(text2).
    const events = [
      userMsg('复杂任务'),
      textDelta('先列一下'),
      toolCall('c1', 'todo.list'),
      toolResult('c1', true, [{ type: 'text', text: '[]' }]),
      textDelta(' 然后继续'),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    expect(turns.map((t) => t.type)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((turns[1] as { text: string }).text).toBe('先列一下');
    expect((turns[3] as { text: string }).text).toBe(' 然后继续');
  });

  it('emits a trailing assistant turn when the log ends without a step boundary', () => {
    const events = [
      userMsg('水果'),
      textDelta('苹果'),
    ];
    const turns = foldHistory(events);
    expect(turns.map((t) => t.type)).toEqual(['user', 'assistant']);
    expect((turns[1] as { text: string }).text).toBe('苹果');
  });

  it('does not emit an empty assistant turn when the log has no assistant content', () => {
    const events = [userMsg('用户问')];
    const turns = foldHistory(events);
    expect(turns).toEqual([{ type: 'user', text: '用户问' }]);
  });

  it('preserves conversation order: user → assistant → user → assistant', () => {
    const events = [
      userMsg('问1', 'u1'),
      textDelta('答1'),
      stepEnd(),
      userMsg('问2', 'u2'),
      textDelta('答2'),
      stepEnd(),
    ];
    const turns = foldHistory(events);
    expect(turns.map((t) => t.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((turns[1] as { text: string }).text).toBe('答1');
    expect((turns[3] as { text: string }).text).toBe('答2');
  });

  it('skips block-start and block-end chunk variants (bookkeeping)', () => {
    const events = [
      userMsg('水果'),
      { type: 'assistant/chunk', data: { chunk: { type: 'block-start' } } },
      textDelta('苹果'),
      { type: 'assistant/chunk', data: { chunk: { type: 'block-end' } } },
      stepEnd(),
    ];
    const turns = foldHistory(events);
    expect(turns).toHaveLength(2);
    expect((turns[1] as { text: string }).text).toBe('苹果');
  });

  it('handles missing/empty data without crashing', () => {
    // Garbage in, garbage out — foldHistory must never throw on missing
    // or empty fields. The persistence plugin should never produce these,
    // but a torn zstd frame at the tail can. We don't assert the exact
    // shape (it's "whatever survives") — only that the function returns
    // SOMETHING and doesn't throw.
    const events = [
      { type: 'user/message' },
      { type: 'assistant/chunk', data: {} },
      { type: 'tool/call' },
    ];
    expect(() => foldHistory(events)).not.toThrow();
    const turns = foldHistory(events);
    expect(Array.isArray(turns)).toBe(true);
    // The unmatched tool/call is still surfaced as a tool turn with
    // ok=false (the "no result" sentinel) — even with no data, the call
    // happened and the user should see that.
    expect(turns.some((t) => t.type === 'tool' && t.ok === false)).toBe(true);
  });

  // ----- create-task envelope regression -----
  // 用户反馈：重启后「AI 创建任务」卡片丢失，变为普通聊天气泡。
  // 锁定「`user/message` 携带 create-task envelope → foldHistory 必须
  // 输出 intent='create-task'」这条契约，防止后续 foldHistory 的小改动
  // 悄悄打破 AIPane 的卡片渲染。

  it('emits a create-task user turn with intent for the versioned envelope', () => {
    // 直接通过 encodeTaskCreationEnvelope 生成 wire 文本，避免硬编码 JSON
    // 格式漂移——只要 envelope 编码契约稳定，测试就稳定。
    const wire = encodeTaskCreationEnvelope('周五交季度报告');
    const turns = foldHistory([userMsg(wire)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      type: 'user',
      text: '周五交季度报告',
      intent: 'create-task',
    });
  });

  it('emits a create-task user turn with intent for the legacy envelope markers', () => {
    // 严格旧封套兼容：pre-L4 JSONL 日志仍带旧方括号标记。
    // foldHistory 必须识别并打上 create-task 标签，让旧会话在重启后
    // 也能继续渲染卡片（向后兼容保证）。
    const legacy =
      '[应用操作模式：创建任务]\n十条规则…\n[用户的任务描述开始]\n旧描述\n[用户的任务描述结束]';
    const turns = foldHistory([userMsg(legacy)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      type: 'user',
      text: '旧描述',
      intent: 'create-task',
    });
  });

  it('emits a plain user turn (no intent) for ordinary chat', () => {
    // 反向断言：普通聊天绝不能被错标成 create-task，防止未来某次改动
    // 让所有用户消息都变成卡片。
    const turns = foldHistory([userMsg('今天天气不错')]);
    expect(turns).toEqual([{ type: 'user', text: '今天天气不错' }]);
    expect((turns[0] as { intent?: unknown }).intent).toBeUndefined();
  });
});
