// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AIStreamEvent } from '../../src/shared/ai-types';

const harness = vi.hoisted(() => ({
  events: [] as AIStreamEvent[],
  subscribers: new Set<() => void>(),
  appListeners: new Map<string, (request: unknown) => void>(),
  composer: null as null | { onChange(text: string): void; onSubmit(): void; onStop(): void; busy: boolean },
  follow: { showJumpToLatest: false, jumpToLatest: () => {}, requestFollow: () => {} },
}));
vi.mock('../../src/renderer/hooks/useTodoListApi', async () => {
  const react = await import('react');
  return {
    useAiStream: () => ({
      events: react.useSyncExternalStore(callback => {
        harness.subscribers.add(callback);
        return () => { harness.subscribers.delete(callback); };
      }, () => harness.events),
      clear: () => { harness.events = []; harness.subscribers.forEach(f => f()); },
    }),
    useAppEvent: (name: string, handler: (value: unknown) => void) => react.useEffect(() => {
      harness.appListeners.set(name, handler);
      return () => { harness.appListeners.delete(name); };
    }, [name, handler]),
    useProviderStatus: () => ({ state: 'ready' }),
    useSettings: () => ({ data: { provider: 'deepseek', model: 'test' } }),
    useStartupAiState: () => ({ state: { status: 'ready' }, retry: vi.fn() }),
  };
});
vi.mock('../../src/renderer/hooks/useChatAutoFollow', () => ({ useChatAutoFollow: () => harness.follow }));
vi.mock('../../src/renderer/data-bus', () => ({ useDataVersion: () => 0 }));
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconEnhanceOutline16: () => null, IconPlusOutline16: () => null,
  IconPaperclipOutline16: () => null, IconWarningOutline16: () => null,
  IconChevronDownOutline14: () => null, Button: () => null,
}));
vi.mock('../../src/renderer/components/icons', () => ({ IconHistory: () => null, IconCollapseBar: () => null }));
vi.mock('../../src/renderer/components/Composer', () => ({ AI_SUBMIT_EVENT: 'test:submit' }));
vi.mock('../../src/renderer/dsh/AIComposer', async () => {
  const react = await import('react');
  return { AIComposer: react.forwardRef((props: NonNullable<typeof harness.composer>, _ref) => {
    harness.composer = props;
    return null;
  }) };
});
vi.mock('../../src/renderer/dsh/PendingQuestionCard', () => ({ PendingQuestionCard: () => null }));
vi.mock('../../src/renderer/dsh/PendingApprovalCard', () => ({ PendingApprovalCard: () => null }));
vi.mock('../../src/renderer/components/AiCreateTaskMessage', () => ({ AiCreateTaskMessage: () => null }));
vi.mock('../../src/renderer/dsh/AssistantTurnContent', async () => {
  const react = await import('react');
  return { AssistantTurnContent: ({ status, blocks }: { status: string; blocks: Array<{ text?: string }> }) =>
    react.createElement('output', { 'data-status': status }, blocks.map(b => b.text ?? '').join('')) };
});

import { AIPane } from '../../src/renderer/panes/AIPane';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Reply = { ok: false; message: string } | { ok: true; data: { content: string } };
let root: Root;
let container: HTMLDivElement;
let first: ReturnType<typeof deferred<Reply>>;
let second: ReturnType<typeof deferred<Reply>>;
let ask: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  harness.events = [];
  first = deferred<Reply>(); second = deferred<Reply>();
  ask = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const conversation = { id: 'conv', title: 'test', updatedAt: 0, archived: false };
  window.todoList = {
    ai: { ask, cancel: vi.fn().mockResolvedValue({ ok: true }) },
    conversation: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { conversations: [conversation], total: 1, remaining: 0 } }),
      history: vi.fn().mockResolvedValue({ ok: true, data: { turns: [] } }),
    },
  } as unknown as typeof window.todoList;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(AIPane)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  harness.appListeners.clear();
});

async function send(text: string) {
  await act(async () => { harness.composer!.onChange(text); });
  await act(async () => { harness.composer!.onSubmit(); });
}

describe('AIPane Stop followed immediately by Send', () => {
  it('does not bind another conversation\'s question to the current composer', async () => {
    await act(async () => {
      harness.appListeners.get('ai:user-question-request')!({
        reqId: 'background-question', invocationId: '', conversationId: 'other-conversation',
        questions: [{ id: 'q1', question: 'Background question?' }],
      });
    });
    await send('current conversation request');
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ ok: true, data: { content: 'answer' } }); });
  });
  it.each<Reply>([
    { ok: true, data: { content: 'late old answer' } },
    { ok: false, message: 'late old failure' },
  ])('preserves cancellation and keeps the new stream visible after old reply $ok', async oldReply => {
    await send('old question');
    await act(async () => { harness.composer!.onStop(); });
    expect(container.querySelector('output')?.getAttribute('data-status')).toBe('cancelled');
    await send('new question');
    expect(ask).toHaveBeenCalledTimes(2);
    const invocationId = ask.mock.calls[1]![0].invocationId as string;
    await act(async () => { first.resolve(oldReply); });
    await act(async () => {
      harness.events = [{ type: 'token', invocationId, token: 'new streamed answer' }];
      harness.subscribers.forEach(f => f());
    });
    const outputs = container.querySelectorAll('output');
    expect(outputs[0]?.getAttribute('data-status')).toBe('cancelled');
    expect(outputs[0]?.textContent).not.toContain('late old answer');
    expect(outputs[1]?.textContent).toBe('new streamed answer');
    expect(outputs[1]?.getAttribute('data-status')).toBe('streaming');
    expect(harness.composer!.busy).toBe(true);
    await act(async () => { second.resolve({ ok: true, data: { content: 'new streamed answer' } }); });
    expect(container.querySelectorAll('output')[1]?.getAttribute('data-status')).toBe('done');
    expect(harness.composer!.busy).toBe(false);
  });
});
