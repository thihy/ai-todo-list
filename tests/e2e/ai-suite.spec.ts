// Comprehensive AI-assistant e2e suite (functionality + styling).
//
// Each case launches the REAL built app and drives either the IPC layer
// (functional contracts) or the actual AIPane UI (rendering / styling).
// Tracked via the cross-session task list in memory/ai-todo-open-issues.md.
//
// Run: pnpm build && pnpm e2e ai-suite
// (Needs a configured API key — same one `pnpm dev` uses.)

import { test, expect } from '@playwright/test';
import {
  launchApp,
  openAiPane,
  askViaIpc,
  createConversation,
  thinkingVisible,
  TEXT_PROMPT,
  LONG_PROMPT,
} from './helpers';

// Every case launches the real app + makes real LLM API calls, which can
// take 10–60s per turn depending on model load. Playwright's default 30s
// per-test timeout is too tight — bump to 3 min for the whole suite.
test.setTimeout(180_000);

// ---------------------------------------------------------------------------
// Functional contracts (IPC-level)
// ---------------------------------------------------------------------------

test('F1 · text Q&A: start → done, IPC ok, content non-empty, no error', async () => {
  const { app, win } = await launchApp();
  try {
    const convId = await createConversation(win, 'e2e-f1');
    const { ipc, events } = await askViaIpc(win, { prompt: TEXT_PROMPT, conversationId: convId });
    console.log('F1 ipc:', JSON.stringify(ipc), '| events:', events.map((e) => `${e.type}(${e.snippet})`).join(' '));
    expect(ipc.ipcError, 'ai.ask must not hang').toBeUndefined();
    expect(ipc.ok, `ai.ask ok; message=${ipc.message}`).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done, 'done event arrives').toBeTruthy();
    expect((done?.snippet.length ?? 0) > 0, 'done.content non-empty (the "no content" bug)').toBe(true);
    expect(events.find((e) => e.type === 'error'), 'no error event').toBeUndefined();
  } finally {
    await app.close();
  }
});

test('F2 · conversation lifecycle: create → list → rename → history → delete', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await createConversation(win, 'e2e-lifecycle');
    expect(id).toBeTruthy();

    // list contains it
    const listed = await win.evaluate(async () => {
      const w = window as unknown as { todoList: { conversation: { list: (o?: { includeArchived?: boolean }) => Promise<{ ok: boolean; data?: { conversations: Array<{ id: string; title: string; archived?: boolean }> } }> } } };
      const r = await w.todoList.conversation.list({ includeArchived: true });
      return r.ok ? r.data!.conversations : [];
    });
    expect(listed.find((c) => c.id === id), 'created conv appears in list').toBeTruthy();

    // rename
    const renameRes = await win.evaluate(async (a: { id: string }) => {
      const w = window as unknown as { todoList: { conversation: { rename: (id: string, title: string) => Promise<{ ok: boolean; message?: string }> } } };
      return w.todoList.conversation.rename(a.id, 'e2e-renamed');
    }, { id });
    expect(renameRes.ok, 'rename ok').toBe(true);

    // a turn so history has something to fold
    await askViaIpc(win, { prompt: TEXT_PROMPT, conversationId: id });

    // history returns at least one turn
    const hist = await win.evaluate(async (a: { id: string }) => {
      const w = window as unknown as { todoList: { conversation: { history: (id: string) => Promise<{ ok: boolean; data?: { turns: unknown[] }; message?: string }> } } };
      const r = await w.todoList.conversation.history(a.id);
      return { ok: r.ok, turns: r.data?.turns ?? [], message: r.message };
    }, { id });
    expect(hist.ok, `history ok; message=${hist.message}`).toBe(true);
    expect(hist.turns.length, 'history has ≥1 turn after a Q&A').toBeGreaterThan(0);

    // The DSH runtime-context plugin injects a "Current runtime context …"
    // user/message (source.kind === 'plugin'). foldHistory must skip it so it
    // never reappears as a stray user bubble on history reload.
    const leakedRuntimeCtx = JSON.stringify(hist.turns).includes('Current runtime context');
    expect(leakedRuntimeCtx, 'runtime-context injection must not leak into folded history').toBe(false);

    // delete
    const delRes = await win.evaluate(async (a: { id: string }) => {
      const w = window as unknown as { todoList: { conversation: { delete: (id: string) => Promise<{ ok: boolean; message?: string }> } } };
      return w.todoList.conversation.delete(a.id);
    }, { id });
    expect(delRes.ok, 'delete ok').toBe(true);
  } finally {
    await app.close();
  }
});

test('F3 · multi-turn: two sequential asks on the same conversation both resolve', async () => {
  const { app, win } = await launchApp();
  try {
    const convId = await createConversation(win, 'e2e-multi');
    const a = await askViaIpc(win, { prompt: TEXT_PROMPT, conversationId: convId });
    const b = await askViaIpc(win, { prompt: '再说一次，简短回答。', conversationId: convId });
    console.log('F3 a:', a.ipc, '| b:', b.ipc);
    expect(a.ipc.ok && b.ipc.ok, 'both turns ok').toBe(true);
    const aDone = a.events.find((e) => e.type === 'done');
    const bDone = b.events.find((e) => e.type === 'done');
    expect(aDone && bDone, 'both turns emit done').toBeTruthy();
    expect((aDone?.snippet.length ?? 0) > 0 && (bDone?.snippet.length ?? 0) > 0, 'both done.content non-empty').toBe(true);
  } finally {
    await app.close();
  }
});

test('F6 · streaming: a long answer arrives as per-token deltas, not one blob', async () => {
  const { app, win } = await launchApp();
  try {
    const convId = await createConversation(win, 'e2e-stream');
    // LONG_PROMPT produces a ~200-char answer; if the session layer streamed
    // assistant/chunk the renderer emits ≥1 `token` event before `done`. Before
    // the llm/stream bridge, 0.1.5-rc.2 only emitted `assistant/message`
    // (assembled) → 0 token events → "思考中…" then a single done blob.
    const { events } = await askViaIpc(win, { prompt: LONG_PROMPT, conversationId: convId });
    console.log('F6 events:', events.map((e) => `${e.type}(${e.snippet})`).join(' '));
    const tokenEvts = events.filter((e) => e.type === 'token');
    expect(tokenEvts.length, 'streaming emits at least one token event').toBeGreaterThan(0);
    // Coalesced token text should be a non-trivial prefix of the answer.
    const tokenText = tokenEvts.map((e) => e.snippet).join('');
    expect(tokenText.length, 'token text non-empty').toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test('F4 · cancel: aborting a long turn does not hang the IPC', async () => {
  const { app, win } = await launchApp();
  try {
    const convId = await createConversation(win, 'e2e-cancel');
    const invocationId = `e2e-cancel-${Date.now()}`;
    // Fire the ask without awaiting; cancel shortly after.
    const askP = win.evaluate(
      async (a: { prompt: string; conversationId: string; invocationId: string }) => {
        const w = window as unknown as { todoList: { ai: { ask: (r: unknown) => Promise<{ ok: boolean; message?: string }> } } };
        try {
          return await w.todoList.ai.ask({ prompt: a.prompt, conversationId: a.conversationId, invocationId: a.invocationId, history: [] });
        } catch (err) {
          return { ok: false, message: (err as Error).message };
        }
      },
      { prompt: LONG_PROMPT, conversationId: convId, invocationId },
    );
    // give the turn a moment to start, then cancel
    await win.waitForTimeout(500);
    const cancelRes = await win.evaluate(async (a: { id: string; inv: string }) => {
      const w = window as unknown as { todoList: { ai: { cancel: (id: string, inv?: string) => Promise<{ ok: boolean }> } } };
      return w.todoList.ai.cancel(a.id, a.inv);
    }, { id: convId, inv: invocationId });
    expect(cancelRes.ok, 'ai.cancel resolves ok').toBe(true);
    // The ask itself must resolve (not hang) after cancel.
    const ask = await Promise.race([
      askP,
      new Promise<{ ok: boolean; message?: string; ipcError: string }>((_, rej) =>
        setTimeout(() => rej(new Error('ask did not resolve after cancel')), 60_000),
      ),
    ]).catch((err) => ({ ok: false, ipcError: (err as Error).message }));
    console.log('F4 ask after cancel:', JSON.stringify(ask));
    expect(ask.ipcError ?? '', 'ask resolves after cancel (no hang)').toBe('');
  } finally {
    await app.close();
  }
});

test('F5 · best-effort tool surface: a tool-prone turn either calls a tool or answers in text', async () => {
  const { app, win } = await launchApp();
  try {
    const convId = await createConversation(win, 'e2e-tool');
    const { ipc, events } = await askViaIpc(win, {
      prompt: '帮我列出我目前的待办任务，只列出，不要总结。如果没有就直说没有。',
      conversationId: convId,
      timeoutMs: 150_000,
    });
    console.log('F5 ipc:', JSON.stringify(ipc), '| events:', events.map((e) => `${e.type}(${e.snippet})`).join(' '));
    // We do NOT assert the model MUST call a tool (non-deterministic). We
    // assert the turn completed and produced *some* content — via a tool
    // (tool/call + tool/result session events) or directly (done.content).
    expect(ipc.ipcError, 'no hang').toBeUndefined();
    const toolCall = events.some((e) => e.type === 'sessionEvent' && e.snippet.includes('tool/call'));
    const done = events.find((e) => e.type === 'done');
    const hasContent = (done?.snippet.length ?? 0) > 0 || toolCall;
    expect(hasContent, 'turn produced content (text answer or a tool call)').toBe(true);
    expect(events.find((e) => e.type === 'error'), 'no error event').toBeUndefined();
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// UI / styling (real AIPane rendering)
// ---------------------------------------------------------------------------

test('U1 · AIPane opens: header + composer + input + send button visible', async () => {
  const { app, win } = await launchApp();
  try {
    await openAiPane(win);
    await expect(win.locator('.aipane__title')).toBeVisible();
    await expect(win.locator('.aipane__composer')).toBeVisible();
    await expect(win.locator('.aipane__input')).toBeVisible();
    await expect(win.locator('.aipane__send')).toBeVisible();
    // Empty state surfaces before the first turn.
    await expect(win.locator('.aipane__empty').first()).toBeVisible();

    // The textarea itself must not draw a second nested focus border; focus
    // belongs to the outer ChatGPT-style composer card.
    const input = win.locator('.aipane__input');
    await input.focus();
    const focusStyle = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        borderTopWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
      };
    });
    expect(focusStyle.outlineStyle).toBe('none');
    expect(focusStyle.borderTopWidth).toBe('0px');
    expect(focusStyle.boxShadow).toBe('none');
  } finally {
    await app.close();
  }
});

test('U2 · send a message: user bubble + assistant bubble + metrics render, no stuck 思考中', async () => {
  const { app, win } = await launchApp();
  try {
    await openAiPane(win);
    const input = win.locator('.aipane__input');
    await input.waitFor({ state: 'visible' });
    await input.fill(TEXT_PROMPT);
    await input.press('Enter');

    // While the answer is pending, neither typing nor file selection is
    // allowed. The stop action remains available separately.
    await expect(input).toBeDisabled({ timeout: 5_000 });
    await expect(win.locator('.aipane__attach-btn')).toBeDisabled({ timeout: 5_000 });

    // User bubble appears with the prompt text.
    const userBubble = win.locator('.bubble--user', { hasText: TEXT_PROMPT.slice(0, 6) });
    await expect(userBubble.first()).toBeVisible({ timeout: 15_000 });

    // Assistant bubble renders non-empty text after the turn resolves.
    const assistantBubble = win.locator('.bubble--assistant');
    await expect(assistantBubble.last()).toBeVisible({ timeout: 120_000 });
    await expect(async () => {
      const txt = (await assistantBubble.last().textContent()) ?? '';
      expect(txt.trim().length, 'assistant bubble has text').toBeGreaterThan(0);
    }).toPass({ timeout: 120_000 });

    // Metrics line renders (status flipped to done → metrics present).
    await expect(win.locator('.aipane__metrics').last()).toBeVisible({ timeout: 30_000 });

    // The "思考中…" indicator must NOT be stuck after the turn settled.
    // Give it a short grace window, then it must be gone.
    await win.waitForTimeout(1000);
    expect(await thinkingVisible(win), 'no stuck 思考中 after turn settles').toBe(false);
  } finally {
    await app.close();
  }
});

test('U3 · metrics line format: "HH:MM · 用时 … · 首 token … · … tok/s"', async () => {
  const { app, win } = await launchApp();
  try {
    await openAiPane(win);
    await win.locator('.aipane__input').fill(TEXT_PROMPT);
    await win.locator('.aipane__input').press('Enter');
    const metrics = win.locator('.aipane__metrics').last();
    await expect(metrics).toBeVisible({ timeout: 120_000 });
    const line = (await metrics.textContent()) ?? '';
    console.log('U3 metrics line:', JSON.stringify(line));
    expect(line, 'contains 用时').toContain('用时');
    expect(line, 'contains tok/s').toContain('tok/s');
  } finally {
    await app.close();
  }
});
