import { describe, expect, it } from 'vitest';
import type { AIStreamEvent } from '../../src/shared/ai-types';
import { compactAiStreamEvents } from '../../src/renderer/dsh/stream-buffer';
import { projectStreamTurn } from '../../src/renderer/dsh/stream-turn';

describe('compactAiStreamEvents', () => {
  it('never truncates the active invocation while bounding older residue', () => {
    const historical = Array.from({ length: 260 }, (_, index): AIStreamEvent => ({
      type: 'sessionEvent',
      invocationId: 'old',
      event: { type: 'step/start', data: { index } },
    }));
    const active = Array.from({ length: 340 }, (_, index): AIStreamEvent => ({
      type: 'toolCall',
      invocationId: 'active',
      toolName: `tool-${index}`,
      args: {},
      result: {},
      ok: true,
    }));

    const compacted = compactAiStreamEvents([...historical, ...active], 'active');

    expect(compacted.filter((event) => event.invocationId === 'active')).toHaveLength(340);
    expect(compacted.filter((event) => event.invocationId === 'old')).toHaveLength(200);
    expect((compacted[0] as Extract<AIStreamEvent, { type: 'sessionEvent' }>).event.data).toEqual({ index: 60 });
  });
});

describe('projectStreamTurn', () => {
  it('preserves reasoning, tool and text order and exposes metrics', () => {
    // Live wire uses `sessionEvent` envelopes carrying the raw DSH
    // SessionEvent (projectStreamTurn is a pure function over that
    // stream). Synthetic `toolCall` events were the old React-updater
    // shape and are no longer emitted — only the session-event form
    // reaches projectStreamTurn now.
    const events: AIStreamEvent[] = [
      { type: 'reasoning', invocationId: 'run', text: '先分析', ts: 10 },
      { type: 'reasoning', invocationId: 'run', text: '再判断', ts: 11 },
      {
        type: 'sessionEvent',
        invocationId: 'run',
        event: {
          type: 'tool/call',
          data: { callId: 'tool-0', name: 'todo_create', arguments: JSON.stringify({ title: '新任务' }) },
        },
        ts: 12,
      },
      {
        type: 'sessionEvent',
        invocationId: 'run',
        event: {
          type: 'tool/result',
          data: {
            message: {
              source: { callId: 'tool-0' },
              content: [{ isError: false, content: [{ type: 'text', text: JSON.stringify({ id: 'todo-1' }) }] }],
            },
            meta: { id: 'todo-1' },
          },
        },
        ts: 13,
      },
      { type: 'token', invocationId: 'run', token: '已经', ts: 20 },
      { type: 'token', invocationId: 'run', token: '完成', ts: 21 },
      { type: 'done', invocationId: 'run', content: '已经完成', costUsd: 0, tokensOut: 2, ts: 30 },
      { type: 'token', invocationId: 'other', token: '不应出现', ts: 5 },
    ];

    expect(projectStreamTurn(events, 'run')).toEqual({
      blocks: [
        { kind: 'reasoning', text: '先分析再判断' },
        {
          kind: 'tool-call',
          callId: 'tool-0',
          name: 'todo_create',
          args: { title: '新任务' },
          argsKnown: true,
          result: { id: 'todo-1' },
          resultKnown: true,
          presentationMeta: { id: 'todo-1' },
          ok: true,
          state: 'done',
        },
        { kind: 'text', text: '已经完成' },
      ],
      status: 'done',
      firstTokenTs: 20,
      endTs: 30,
      tokensOut: 2,
      createdTodoId: 'todo-1',
    });
  });

  it('uses done content when the provider emitted no token deltas', () => {
    const projection = projectStreamTurn([
      { type: 'done', invocationId: 'run', content: '一次性回答', costUsd: 0, ts: 40 },
    ], 'run');
    expect(projection?.blocks).toEqual([{ kind: 'text', text: '一次性回答' }]);
    expect(projection?.status).toBe('done');
  });
});
