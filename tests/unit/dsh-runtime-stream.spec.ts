import { describe, expect, it, vi } from 'vitest';
import { bridgeLlmStream, type DshRawEvent } from '../../src/main/dsh/dsh-runtime';

describe('bridgeLlmStream', () => {
  it('forwards text and reasoning deltas immediately and preserves all chunks', async () => {
    const chunks = [
      { type: 'block-start', index: 0 },
      { type: 'reasoning-delta', index: 0, text: '先思考' },
      { type: 'text-delta', index: 1, text: '你好' },
      { type: 'finish', reason: 'stop' },
    ];
    const events: DshRawEvent[] = [];
    const onEvent = vi.fn((event: DshRawEvent) => events.push(event));

    async function* upstream() {
      for (const chunk of chunks) yield chunk;
    }

    const iterator = bridgeLlmStream(upstream(), onEvent)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: chunks[0], done: false });
    expect(onEvent).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual({ value: chunks[1], done: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ value: chunks[2], done: false });
    expect(onEvent).toHaveBeenCalledTimes(2);
    await expect(iterator.next()).resolves.toEqual({ value: chunks[3], done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(events).toEqual([
      { type: 'assistant/chunk', data: { chunk: chunks[1] } },
      { type: 'assistant/chunk', data: { chunk: chunks[2] } },
    ]);
  });
});
