// runtime.cancel / disposeConversation 修复的回归测试。
//
// 症状背景：旧 AIPane 的 Stop 按钮点下去后，DSH agent 被 cancel 但 in-flight
// tool / pending HITL entries 全部卡住。修复路径：
//   1. `drainPendingForConversation(convId)` 在 runtime.cancel 和
//      disposeConversation 里被调用，把那个 conv 的 pending question /
//      approval 全清掉并广播 `ai:user-{question,approval}-cancelled` 事件。
//   2. approval 监听器的 signal.abort 路径调 `settle('cancelled')`，内部
//      走相同的 `broadcastCancel('approval', reqId)` —— 同一段广播逻辑。
//   3. question 监听器的 90s 超时调 `settle('timeout')` / `settle('cancelled')`
//      也走 `broadcastCancel`（timeout 路径走 `ai:user-question-timeout`）。
//
// 测试目标：drain 在不清空 peer conversation 的前提下清掉本 conv 的 pending
// 条目，并发出对应 cancel 事件。signal-driven / timeout 路径是 listener 闭包
// 内部的实现细节，行为与 drain 完全一致，因此这条 pipeline 由 drain 测试间
// 接覆盖。
//
// 副作用：mock electron 的 BrowserWindow.getAllWindows() 让我们捕获广播。

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
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const runtime = await import('../../src/main/dsh/dsh-runtime');
const {
  drainPendingForConversation,
  __pendingSnapshotForTest,
  __seedPendingQuestionForTest,
  __seedPendingApprovalForTest,
  grantSessionTool,
  clearSessionGrants,
} = runtime;

const CONV_A = 'conv-A';
const CONV_B = 'conv-B';

// 每个测前清掉上一测的种子 + 广播 — 模块作用域状态会跨测共享。
beforeEach(() => {
  broadcastCalls.length = 0;
  clearSessionGrants(CONV_A);
  clearSessionGrants(CONV_B);
  // 清残留的 pending 状态（beforeEach 不直接调 drain — 部分测需要预置 state
  // 后观察 drain 副作用，所以这里强制清掉 timer / map entry）。
  const snap = __pendingSnapshotForTest();
  for (const c of Object.keys(snap.questions)) {
    drainPendingForConversation(c);
  }
  for (const c of Object.keys(snap.approvals)) {
    drainPendingForConversation(c);
  }
  broadcastCalls.length = 0;
});

afterEach(() => {
  // 保险：测试结束释放任何悬挂的 60s fake timer。
  const snap = __pendingSnapshotForTest();
  for (const c of Object.keys(snap.questions)) drainPendingForConversation(c);
  for (const c of Object.keys(snap.approvals)) drainPendingForConversation(c);
});

describe('__pendingSnapshotForTest', () => {
  it('returns empty records when no entries are pending', () => {
    expect(__pendingSnapshotForTest()).toEqual({ questions: {}, approvals: {} });
  });

  it('counts pending entries per conversation', () => {
    const q1 = __seedPendingQuestionForTest(CONV_A, 'q1');
    const q2 = __seedPendingQuestionForTest(CONV_A, 'q2');
    const a1 = __seedPendingApprovalForTest(CONV_A, 'a1');
    const qb = __seedPendingQuestionForTest(CONV_B, 'qb');
    try {
      expect(__pendingSnapshotForTest()).toEqual({
        questions: { [CONV_A]: 2, [CONV_B]: 1 },
        approvals: { [CONV_A]: 1 },
      });
    } finally {
      q1.cleanup(); q2.cleanup(); a1.cleanup(); qb.cleanup();
    }
  });
});

describe('drainPendingForConversation', () => {
  it('clears all pending question + approval entries for one conversation', () => {
    const qa = __seedPendingQuestionForTest(CONV_A, 'qa');
    const aa = __seedPendingApprovalForTest(CONV_A, 'aa');
    drainPendingForConversation(CONV_A);
    expect(__pendingSnapshotForTest()).toEqual({ questions: {}, approvals: {} });
    // Approval settle resolves with 'cancelled'.
    void aa.promise.then((o) => expect(o).toBe('cancelled'));
    qa.cleanup(); aa.cleanup();
  });

  it('does NOT touch pending entries for a peer conversation', () => {
    const qa = __seedPendingQuestionForTest(CONV_A, 'qa');
    const qb = __seedPendingQuestionForTest(CONV_B, 'qb');
    const ab = __seedPendingApprovalForTest(CONV_B, 'ab');
    try {
      drainPendingForConversation(CONV_A);
      expect(__pendingSnapshotForTest()).toEqual({
        questions: { [CONV_B]: 1 },
        approvals: { [CONV_B]: 1 },
      });
    } finally {
      qa.cleanup(); qb.cleanup(); ab.cleanup();
    }
  });

  it('broadcasts ai:user-question-cancelled once per cleared question', () => {
    const q1 = __seedPendingQuestionForTest(CONV_A, 'q1');
    const q2 = __seedPendingQuestionForTest(CONV_A, 'q2');
    const qb = __seedPendingQuestionForTest(CONV_B, 'qb-other');
    try {
      broadcastCalls.length = 0; // beforeEach drains, but be explicit
      drainPendingForConversation(CONV_A);
      const questionCancels = broadcastCalls
        .filter((c) => c.channel === 'ai:user-question-cancelled')
        .map((c) => c.payload);
      expect(questionCancels).toHaveLength(2);
      expect(questionCancels.map((p) => (p as { reqId: string }).reqId).sort())
        .toEqual(['q1', 'q2']);
    } finally {
      q1.cleanup(); q2.cleanup(); qb.cleanup();
    }
  });

  it('broadcasts ai:user-approval-cancelled once per cleared approval', () => {
    const a1 = __seedPendingApprovalForTest(CONV_A, 'a1');
    const a2 = __seedPendingApprovalForTest(CONV_A, 'a2');
    try {
      broadcastCalls.length = 0;
      drainPendingForConversation(CONV_A);
      const approvalCancels = broadcastCalls
        .filter((c) => c.channel === 'ai:user-approval-cancelled')
        .map((c) => c.payload);
      expect(approvalCancels).toHaveLength(2);
      expect(approvalCancels.map((p) => (p as { reqId: string }).reqId).sort())
        .toEqual(['a1', 'a2']);
    } finally {
      a1.cleanup(); a2.cleanup();
    }
  });

  it('does NOT broadcast for peer conversation entries', () => {
    const qa = __seedPendingQuestionForTest(CONV_A, 'qa');
    const qb = __seedPendingQuestionForTest(CONV_B, 'qb');
    try {
      broadcastCalls.length = 0;
      drainPendingForConversation(CONV_A);
      const reqIds = broadcastCalls
        .filter((c) => c.channel === 'ai:user-question-cancelled')
        .map((c) => (c.payload as { reqId: string }).reqId);
      expect(reqIds).toEqual(['qa']);
      expect(reqIds).not.toContain('qb');
    } finally {
      qa.cleanup(); qb.cleanup();
    }
  });

  it('is a no-op when there are no pending entries for the conversation', () => {
    const qb = __seedPendingQuestionForTest(CONV_B, 'qb');
    try {
      drainPendingForConversation(CONV_A);
      expect(broadcastCalls.filter((c) => c.channel === 'ai:user-question-cancelled'))
        .toHaveLength(0);
      expect(__pendingSnapshotForTest()).toEqual({
        questions: { [CONV_B]: 1 },
        approvals: {},
      });
    } finally {
      qb.cleanup();
    }
  });

  it('rejects pending question promises (DSH waterfall error path)', async () => {
    const qa = __seedPendingQuestionForTest(CONV_A, 'qa');
    drainPendingForConversation(CONV_A);
    await expect(qa.promise).rejects.toThrow(/aborted before the user answered/);
    qa.cleanup();
  });

  it('resolves pending approval promises with cancelled outcome', async () => {
    const aa = __seedPendingApprovalForTest(CONV_A, 'aa');
    drainPendingForConversation(CONV_A);
    await expect(aa.promise).resolves.toBe('cancelled');
    aa.cleanup();
  });
});

describe('drainPendingForConversation × session grants', () => {
  it('does NOT clear session-grant entries (orthogonal to grants)', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'bash');
    drainPendingForConversation(CONV_A);
    // session grants persist — they live in their own Map and are cleared
    // via clearSessionGrants, not by drain.
    expect(runtime.listSessionGranted(CONV_A).sort()).toEqual(['bash', 'write']);
  });
});