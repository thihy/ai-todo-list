// Automated AI Q&A test.
//
// Goal: stop relying on manual clicks to reproduce "一直显示思考中… 然后没有
// 任何内容". This launches the REAL (built) app via Playwright's electron
// driver, drives the exact IPC path the AIPane uses
// (`window.todoList.ai.ask` + `ai:stream` events), and reports the full event
// timeline + whether the turn resolved.
//
// Two diagnostic outcomes:
//   - IPC never resolves (timeout) and no `done` event  → runTurn HANGS on the
//     backend (DSH agent loop / persistence / LLM adapter). That is the root
//     cause of "思考中… + 没有内容": runSubmit's authoritative status flip
//     (AIPane L6-A) never fires because `ai.ask` never returns.
//   - IPC resolves ok AND a `done` event with content arrives → backend is
//     fine; the stuck-thinking bug is renderer-side (stale build / a flaw in
//     the T2 fix). Then the UI-level test below is the next probe.
//
// Run: pnpm build && pnpm e2e ai-ask
// (Needs a configured API key in the app's settings — same one the user runs
// `pnpm dev` with.)

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

const ASK_PROMPT = '用一句话回答：1+1等于几？不要调用任何工具。';
const ASK_TIMEOUT_MS = 120_000;

// Real app + real LLM call — give the whole test 3 min (Playwright's default
// 30s per-test timeout is too tight for a slow model response).
test.setTimeout(180_000);

test('ai.ask (text-only) completes: start → done, IPC resolves, content non-empty', async () => {
  const app = await electron.launch({ args: ['.'] });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const trace = await win.evaluate(
      async (args: { prompt: string; timeoutMs: number }) => {
        const { prompt, timeoutMs } = args;
        const w = window as unknown as {
          todoList: {
            on: (e: 'ai:stream', cb: (p: unknown) => void) => () => void;
            ai: {
              ask: (r: {
                prompt: string;
                conversationId: string;
                invocationId?: string;
                history?: { role: 'user' | 'assistant'; content: string }[];
              }) => Promise<{ ok: boolean; message?: string; data?: { invocationId?: string; costUsd?: number } }>;
            };
            conversation: {
              create: (i?: { title?: string }) => Promise<{ ok: boolean; data?: { conversation: { id: string } }; message?: string }>;
            };
          };
        };

        const events: Array<{ t: number; type: string; snippet: string; extra?: Record<string, unknown> }> = [];
        const off = w.todoList.on('ai:stream', (payload) => {
          const e = payload as { type: string; invocationId?: string; content?: string; token?: string; message?: string; tokensOut?: number; event?: { type?: string; data?: unknown } };
          const t = Date.now();
          const ev = e as { type: string; content?: string; token?: string; message?: string; tokensOut?: number; event?: { type?: string } };
          let snippet = '';
          if (ev.type === 'sessionEvent') {
            snippet = `session/${ev.event?.type ?? '?'}`;
          } else if (ev.type === 'token') {
            snippet = (ev.token ?? '').slice(0, 40);
          } else if (ev.type === 'done') {
            snippet = (ev.content ?? '').slice(0, 80);
          } else if (ev.type === 'error') {
            snippet = ev.message ?? '';
          }
          events.push({
            t,
            type: e.type,
            snippet,
            ...(e.tokensOut != null ? { tokensOut: e.tokensOut } : {}),
          });
        });

        // Allocate a conversation row (ai.ask requires a real DB row).
        const conv = await w.todoList.conversation.create({ title: 'e2e-ask' });
        if (!conv.ok || !conv.data?.conversation?.id) {
          off();
          return { kind: 'conv-create-failed', message: conv.message ?? '(no message)' as string, events };
        }
        const conversationId = conv.data.conversation.id;
        const invocationId = `e2e-${Date.now()}`;
        const t0 = Date.now();

        let ipcRes: { ok: boolean; message?: string; data?: { invocationId?: string; costUsd?: number } } | { ipcError: string };
        try {
          ipcRes = await Promise.race([
            w.todoList.ai.ask({ prompt, conversationId, invocationId, history: [] }),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`ask IPC did not resolve within ${timeoutMs}ms`)), timeoutMs),
            ),
          ]);
        } catch (err) {
          ipcRes = { ipcError: (err as Error).message };
        }
        const tEnd = Date.now();
        off();

        return {
          kind: 'done' as const,
          conversationId,
          invocationId,
          t0,
          tEnd,
          durationMs: tEnd - t0,
          events,
          ipcRes,
        };
      },
      { prompt: ASK_PROMPT, timeoutMs: ASK_TIMEOUT_MS },
    );

    // Always print the timeline so a failure is self-explanatory.
    console.log('\n================ AI ASK TRACE ================');
    console.log(JSON.stringify(trace, null, 2));
    console.log('=============================================\n');

    if (trace.kind === 'conv-create-failed') {
      throw new Error(`conversation.create failed: ${trace.message}`);
    }

    const ipc = trace.ipcRes as { ok?: boolean; message?: string; ipcError?: string; data?: { invocationId?: string; costUsd?: number } };
    expect(ipc.ipcError, 'ai.ask IPC must resolve (not hang)').toBeUndefined();
    expect(ipc.ok, `ai.ask should resolve ok; got message=${ipc.message}`).toBe(true);

    const done = trace.events.find((x) => x.type === 'done');
    expect(done, 'a `done` ai:stream event must arrive').toBeTruthy();
    expect((done?.snippet.length ?? 0) > 0, 'done event must carry non-empty content').toBe(true);

    // And no `error` event should have preceded done.
    const err = trace.events.find((x) => x.type === 'error');
    expect(err, `no error event expected; got: ${err?.snippet}`).toBeUndefined();
  } finally {
    await app.close();
  }
});
