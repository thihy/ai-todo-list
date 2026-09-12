// Shared helpers for the AI-assistant e2e suite.
//
// Launches the REAL built app via Playwright's electron driver, opens the AI
// pane (route `#/ai` → App.tsx setAiOpen(true)), and exposes a tiny event
// collector so tests can assert on the `ai:stream` timeline the UI itself
// consumes.

import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AppHandle {
  app: ElectronApplication;
  win: Page;
}

export interface StreamEvt {
  type: string;
  snippet: string;
  tokensOut?: number;
}

/** Prompt that reliably produces a short text answer WITHOUT calling tools —
 *  used for the fast, deterministic functional + UI tests. */
export const TEXT_PROMPT = '用一句话回答：1+1等于几？不要调用任何工具。';
/** Long-ish prompt for the cancel test — gives the agent something to stream
 *  before we abort. Keep it non-trivial so cancel has a window to land. */
export const LONG_PROMPT = '写一段 200 字左右的中文短文，介绍光的作用。不要调用工具。';

export async function launchApp(): Promise<AppHandle> {
  // Test runners in this repository use Electron itself as the Node runtime.
  // Do not leak that switch into the child process: Playwright needs to start
  // the binary in normal Electron mode, otherwise Chromium flags are rejected
  // with `bad option: --remote-debugging-port=0`.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_ALLOW_MULTI_INSTANCE = '1';
  env.ELECTRON_E2E = '1';
  // Isolate Chromium state and the process-singleton lock from the user's
  // running app. Seed dataDir too: the production default intentionally lives
  // beside userData, which would otherwise make every E2E run share the same
  // temp/.todo-list database despite having a unique Chromium profile.
  const userDataDir = mkdtempSync(join(tmpdir(), 'ai-todo-e2e-'));
  writeFileSync(
    join(userDataDir, 'config.json'),
    JSON.stringify({ dataDir: join(userDataDir, 'data') }),
    'utf8',
  );
  const app = await electron.launch({
    // CI/sandbox Windows images may not provide the GPU runtime DLLs used by
    // Chromium. Software rendering keeps UI assertions deterministic without
    // changing production hardware acceleration.
    args: [`--user-data-dir=${userDataDir}`, '--disable-gpu', '--no-sandbox', '.'],
    env,
  });
  const processOutput: string[] = [];
  app.process().stdout?.on('data', (chunk) => processOutput.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => processOutput.push(String(chunk)));
  let windowUrl = '(window not created)';
  try {
    const win = await app.firstWindow();
    windowUrl = win.url();
    win.on('close', () => processOutput.push(`window closed while loading: ${windowUrl}`));
    await win.waitForLoadState('domcontentloaded');
    app.on('close', () => {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    return { app, win };
  } catch (error) {
    const logPath = join(userDataDir, 'todo-list.log');
    const appLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    await app.close().catch(() => undefined);
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Keep the original launch error; the OS may briefly retain cache locks.
    }
    throw new Error(
      [`Electron window failed to load (${windowUrl}): ${(error as Error).message}`, ...processOutput, appLog]
        .filter(Boolean)
        .join('\n'),
      { cause: error },
    );
  }
}

/** Open the AI pane (route `#/ai` flips App.tsx's aiOpen to true). Idempotent. */
export async function openAiPane(win: Page): Promise<void> {
  await win.evaluate(() => {
    location.hash = '/ai';
  });
  await win.waitForSelector('.aipane__composer', { timeout: 15_000 });
}

/** Install an `ai:stream` collector on the renderer. Returns a function that
 *  drains the collected events (call it after the turn). The collector stays
 *  installed until `stop()`. */
export function streamCollector(win: Page): { drain: () => Promise<StreamEvt[]>; stop: () => Promise<void> } {
  // Install in one evaluate; store buffer + off-handle on the window so the
  // drain/stop calls can reach them.
  void win.evaluate(() => {
    const w = window as unknown as {
      __e2e_buf?: unknown[];
      __e2e_off?: () => void;
      todoList: { on: (e: 'ai:stream', cb: (p: unknown) => void) => () => void };
    };
    w.__e2e_buf = [];
    w.__e2e_off = w.todoList.on('ai:stream', (p) => {
      w.__e2e_buf!.push(p);
    });
  });
  return {
    drain: async () => {
      const raw = (await win.evaluate(() => {
        const w = window as unknown as { __e2e_buf?: unknown[] };
        const buf = (w.__e2e_buf ?? []).slice();
        w.__e2e_buf = [];
        return buf;
      })) as Array<{ type: string; token?: string; content?: string; message?: string; tokensOut?: number; event?: { type?: string } }>;
      return raw.map((e) => {
        let snippet = '';
        if (e.type === 'sessionEvent') snippet = `session/${e.event?.type ?? '?'}`;
        else if (e.type === 'token') snippet = (e.token ?? '').slice(0, 60);
        else if (e.type === 'done') snippet = (e.content ?? '').slice(0, 120);
        else if (e.type === 'error') snippet = e.message ?? '';
        const out: StreamEvt = { type: e.type, snippet };
        if (e.tokensOut != null) out.tokensOut = e.tokensOut;
        return out;
      });
    },
    stop: () =>
      win.evaluate(() => {
        const w = window as unknown as { __e2e_off?: () => void; __e2e_buf?: unknown[] };
        w.__e2e_off?.();
        w.__e2e_buf = [];
      }),
  };
}

/** Drive `window.todoList.ai.ask` from the renderer and return the IPC result
 *  plus the ai:stream event timeline collected during the turn (self-contained:
 *  installs its own listener). */
export async function askViaIpc(
  win: Page,
  args: { prompt: string; conversationId: string; invocationId?: string; timeoutMs?: number },
): Promise<{
  ipc: { ok?: boolean; message?: string; ipcError?: string; data?: { invocationId?: string; costUsd?: number } };
  events: StreamEvt[];
  durationMs: number;
}> {
  const { prompt, conversationId, invocationId = `e2e-${Date.now()}`, timeoutMs = 120_000 } = args;
  return win.evaluate(
    async (a: { prompt: string; conversationId: string; invocationId: string; timeoutMs: number }) => {
      const w = window as unknown as {
        todoList: {
          ai: { ask: (r: unknown) => Promise<{ ok: boolean; message?: string; data?: { invocationId?: string; costUsd?: number } }> };
          on: (e: 'ai:stream', cb: (p: unknown) => void) => () => void;
        };
      };
      const buf: Array<{ type: string; token?: string; content?: string; message?: string; tokensOut?: number; event?: { type?: string } }> = [];
      const off = w.todoList.on('ai:stream', (p) => buf.push(p as typeof buf[number]));
      const t0 = Date.now();
      let ipc: { ok?: boolean; message?: string; ipcError?: string; data?: { invocationId?: string; costUsd?: number } };
      try {
        ipc = await Promise.race([
          w.todoList.ai.ask({
            prompt: a.prompt,
            conversationId: a.conversationId,
            invocationId: a.invocationId,
            history: [],
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`ask IPC did not resolve within ${a.timeoutMs}ms`)), a.timeoutMs),
          ),
        ]);
      } catch (err) {
        ipc = { ipcError: (err as Error).message };
      }
      const tEnd = Date.now();
      off();
      const events = buf.map((e) => {
        let snippet = '';
        if (e.type === 'sessionEvent') snippet = `session/${e.event?.type ?? '?'}`;
        else if (e.type === 'token') snippet = (e.token ?? '').slice(0, 60);
        else if (e.type === 'done') snippet = (e.content ?? '').slice(0, 120);
        else if (e.type === 'error') snippet = e.message ?? '';
        const out: { type: string; snippet: string; tokensOut?: number } = { type: e.type, snippet };
        if (e.tokensOut != null) out.tokensOut = e.tokensOut;
        return out;
      });
      return { ipc, events, durationMs: tEnd - t0 };
    },
    { prompt, conversationId, invocationId, timeoutMs },
  );
}

/** Create a conversation row and return its id. */
export async function createConversation(win: Page, title = 'e2e'): Promise<string> {
  const id = await win.evaluate(async (t: string) => {
    const w = window as unknown as {
      todoList: { conversation: { create: (i?: { title?: string }) => Promise<{ ok: boolean; data?: { conversation: { id: string } }; message?: string }> } };
    };
    const r = await w.todoList.conversation.create({ title: t });
    return r.ok && r.data?.conversation?.id ? r.data.conversation.id : null;
  }, title);
  if (!id) throw new Error('conversation.create failed');
  return id;
}

/** Snapshot whether the "思考中…" indicator is currently shown. */
export async function thinkingVisible(win: Page): Promise<boolean> {
  const loc = win.locator('.aipane__thinking');
  return (await loc.count()) > 0 && (await loc.first().isVisible());
}
