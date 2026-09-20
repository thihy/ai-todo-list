// user-questions/request waterfall 监听器的 signal 处理回归测试。
//
// 症状背景：DSH 在 ask_user_question 上挂着 promise 等 renderer 应答。如果
// 用户在问题卡片显示期间点 Stop,旧实现只走 drainPendingForConversation(convId),
// 那个路径在某些 race 下清不掉(例如 activeTurnConversations 还未 set、convId
// 为空串)，导致 promise 永远 pending、agent.whenIdle() 不 resolve、AIPane
// 转圈显示"运行中"。
//
// 修复路径：监听 `request.signal`(DSH 把 calling agent 的 lifecycle signal 透
// 传到 waterfall request 形状里,见 dsh-tool-ask-user execute → ctx.userQuestions
// .ask({signal: exec.signal})),abort 时 settle('cancelled') —— 与 approval
// 监听器的 signal 处理镜像。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const broadcastCalls: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            broadcastCalls.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const runtime = await import('../../src/main/dsh/dsh-runtime');
const {
  handleUserQuestionRequest,
  drainPendingForConversation,
  answerUserQuestion,
  __pendingSnapshotForTest,
} = runtime;

const CONV = 'conv-listener-test';

beforeEach(() => {
  broadcastCalls.length = 0;
  // Clear any leftover state from previous tests.
  const snap = __pendingSnapshotForTest();
  for (const c of Object.keys(snap.questions)) drainPendingForConversation(c);
  for (const c of Object.keys(snap.approvals)) drainPendingForConversation(c);
  broadcastCalls.length = 0;
});

afterEach(() => {
  // Safety net: any 90s timer the test forgot to settle must not leak.
  const snap = __pendingSnapshotForTest();
  for (const c of Object.keys(snap.questions)) drainPendingForConversation(c);
  for (const c of Object.keys(snap.approvals)) drainPendingForConversation(c);
});

const SAMPLE_QUESTIONS = [
  {
    id: 'q1',
    question: 'Pick one?',
    header: 'Choice',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ],
    multiSelect: false,
  },
];

describe('handleUserQuestionRequest — signal handling', () => {
  it('rejects immediately and broadcasts cancel when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS, signal: ac.signal }, CONV);
    await expect(promise).rejects.toThrow(/aborted before the user answered/);
    const cancels = broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled');
    expect(cancels).toHaveLength(1);
    // Map should be empty — nothing pending to drain later.
    expect(__pendingSnapshotForTest().questions[CONV] ?? 0).toBe(0);
  });

  it('rejects and broadcasts cancel when signal aborts after registration', async () => {
    const ac = new AbortController();
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS, signal: ac.signal }, CONV);
    // Listener registered; pending entry exists.
    expect(__pendingSnapshotForTest().questions[CONV] ?? 0).toBe(1);
    expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-request')).toHaveLength(1);

    ac.abort();

    await expect(promise).rejects.toThrow(/aborted before the user answered/);
    const cancels = broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled');
    expect(cancels).toHaveLength(1);
    expect(__pendingSnapshotForTest().questions[CONV] ?? 0).toBe(0);
  });

  it('cleans up signal listener after settle (no double-fire)', async () => {
    const ac = new AbortController();
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS, signal: ac.signal }, CONV);
    // First abort: settle fires, promise rejects.
    ac.abort();
    await expect(promise).rejects.toThrow();
    expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled')).toHaveLength(1);
    broadcastCalls.length = 0;
    // A late abort after settle must NOT broadcast again (listener removed).
    ac.abort();
    // Yield a microtask so any errant listener could fire.
    await Promise.resolve();
    expect(broadcastCalls).toHaveLength(0);
  });

  it('does NOT broadcast cancel when the user answered before abort', async () => {
    const ac = new AbortController();
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS, signal: ac.signal }, CONV);
    // Resolve the question (find the live reqId from the broadcast).
    const reqPayload = broadcastCalls.find((c) => c.channel === 'ai:user-question-request')?.payload as
      | { reqId: string }
      | undefined;
    expect(reqPayload?.reqId).toBeTruthy();
    const ok = answerUserQuestion(reqPayload!.reqId, [
      { id: 'q1', selected: ['A'] },
    ]);
    expect(ok).toBe(true);
    await expect(promise).resolves.toEqual({
      reqId: reqPayload!.reqId,
      answers: [{ id: 'q1', selected: ['A'] }],
    });
    // Now abort — must NOT re-broadcast cancel (entry is gone).
    broadcastCalls.length = 0;
    ac.abort();
    await Promise.resolve();
    expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled')).toHaveLength(0);
  });

  it('does NOT broadcast cancel when drainPendingForConversation already cleared the entry', async () => {
    const ac = new AbortController();
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS, signal: ac.signal }, CONV);
    expect(__pendingSnapshotForTest().questions[CONV] ?? 0).toBe(1);
    // Drain from the Stop path first.
    drainPendingForConversation(CONV);
    const drainBroadcasts = broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled');
    expect(drainBroadcasts).toHaveLength(1);
    // Now abort. settle() must see the map empty and bail — no second broadcast.
    broadcastCalls.length = 0;
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted before the user answered/);
    expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled')).toHaveLength(0);
  });

  it('signal-less request falls back to existing behavior (registers, broadcasts request, waits)', () => {
    const promise = handleUserQuestionRequest({ questions: SAMPLE_QUESTIONS }, CONV);
    expect(__pendingSnapshotForTest().questions[CONV] ?? 0).toBe(1);
    expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-request')).toHaveLength(1);
    // Pending stays until afterEach drains it. Swallow the rejection so vitest
    // doesn't flag it as unhandled — afterEach's drain is cleanup, not a test
    // assertion.
    void promise.catch(() => {});
  });
});