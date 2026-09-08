// IPC handlers for AI channels.
// ai.invoke streams events via 'ai:stream'; ai.health / ai.models / ai.cancel are non-streaming.

import { register, okResult, failResult } from './router';
import type { DshHandle } from '../dsh/types';
import { tierFor } from '../dsh/tools';
import { resolveEndpoint, invokeChat, makeSystemPrompt, healthCheck } from '../dsh/client';
import { getDshRuntime } from '../dsh/dsh-runtime';
import { SettingsStore } from '../settings/store';
import { BrowserWindow } from 'electron';
import type { AIStreamEvent } from '../../shared/ai-types';
import { TodoRepo } from '../db/todo-repo';
import { MarkdownStore } from '../files/markdown';
import { DrawingStore } from '../files/drawings';

interface HandlerDeps {
  dsh: DshHandle;
  settings: SettingsStore;
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
}

let deps: HandlerDeps | null = null;

export function registerAiHandlers(dsh: DshHandle): void {
  // The remaining deps are pulled in lazily because the IPC router is wired before
  // DSH is initialised in bootstrap(). They live on globals set in main/index.ts.
  // We bind a thin wrapper that re-fetches the deps on each call.

  register('ai.health', async () => {
    try {
      if (!deps) return okResult({ ok: false, mode: dsh.health().mode, error: 'not_ready' });
      const s = deps.settings.get();
      const ep = resolveEndpoint(s);
      // Ollama (local) has no API key but is still reachable — treat a resolved
      // endpoint as sufficient. Shim / unconfigured custom → no_api_key.
      if (!ep) return okResult({ ok: false, mode: dsh.health().mode, error: 'no_api_key' });
      if (ep.protocol !== 'openai' || s.provider !== 'ollama') {
        if (!ep.apiKey) return okResult({ ok: false, mode: dsh.health().mode, error: 'no_api_key' });
      }
      const hc = await healthCheck(ep);
      if (hc.ok) deps.settings.recordHeartbeat();
      return okResult({ ok: hc.ok, mode: dsh.health().mode, latencyMs: hc.latencyMs, error: hc.error });
    } catch (err) {
      return failResult('health_failed', (err as Error).message);
    }
  });

  register('ai.models', () => Promise.resolve(okResult({ models: dsh.models() })));

  register('ai.cancel', (_e, req) => {
    dsh.cancel(req.invocationId);
    return Promise.resolve(okResult({ ok: true }));
  });

  // Streaming "ask AI" used by the AIPane submit; main pushes stream events.
  register('ai.ask', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    const s = deps.settings.get();
    const ep = resolveEndpoint(s);
    if (!ep) return failResult('no_api_key', 'Set API key / baseURL in settings first');
    if (ep.protocol !== 'openai' || s.provider !== 'ollama') {
      if (!ep.apiKey) return failResult('no_api_key', 'Set API key in settings first');
    }

    // Use the caller-provided id so the renderer can match streamed token/done
    // events that arrive before this IPC response resolves.
    const invocationId = req.invocationId ?? crypto.randomUUID();
    const model = req.model ?? ep.model;

    const send = (event: AIStreamEvent): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ai:stream', event);
      }
    };

    send({ type: 'start', invocationId });

    // DSH agent-loop path (tool-calling). Boot is lazy and may fail (RC
    // packages, build packaging); on null we fall through to the text-only
    // client.ts invokeChat path below, so the app keeps working either way.
    const runtime = await getDshRuntime({
      getEndpoint: () => ep,
      repo: deps.repo,
      md: deps.md,
      drawings: deps.drawings,
    });
    if (runtime) {
      try {
        await runtime.runTurn({
          prompt: req.prompt,
          invocationId,
          onEvent: (e) => {
            switch (e.type) {
              case 'token':
                send({ type: 'token', invocationId, token: e.text });
                break;
              case 'toolResult':
                // The renderer's AIToolCallEvent carries the completed call +
                // its result together; DSH splits call/result, so emit on result.
                send({ type: 'toolCall', invocationId, toolName: e.name, args: undefined, result: e.ok ? e.data : e.error });
                break;
              case 'done':
                send({ type: 'done', invocationId, content: e.content, costUsd: 0 });
                break;
              case 'error':
                send({ type: 'error', invocationId, message: e.message });
                break;
              // 'toolCall' (pre-execution) is intentionally not forwarded —
              // the UI shows completed calls via the toolResult mapping above.
            }
          },
        });
        return okResult({ invocationId, costUsd: 0 });
      } catch (err) {
        const message = (err as Error).message;
        send({ type: 'error', invocationId, message });
        return failResult('invoke_failed', message);
      }
    }

    // ---------- fallback: text-only client.ts invokeChat (no tool-calling) ----------

    // Permission gate for any tools the agent wants to call.
    const pendingPermissions = new Map<string, Promise<boolean>>();
    const onPermission = (tool: string, args: unknown): Promise<boolean> => {
      const tier = tierFor(tool);
      if (tier === 'auto') return Promise.resolve(true);
      const preview = JSON.stringify(args).slice(0, 240);
      send({
        type: 'permissionRequest',
        invocationId,
        tool,
        preview,
        tier,
      });
      if (tier === 'notify-undo') {
        setTimeout(() => sendUndoToast(tool, invocationId), 0);
        return Promise.resolve(true);
      }
      return pendingPermissions.get(invocationId + ':' + tool) ?? Promise.resolve(false);
    };
    void onPermission;
    void pendingPermissions;

    try {
      const systemPrompt = makeSystemPrompt();
      // Build the full conversation: prior turns (multi-turn context) followed
      // by the newest user message. Without history, each message is an
      // independent one-shot — the model forgets everything said before, which
      // is why the assistant felt "crude".
      const messages = [...(req.history ?? []), { role: 'user' as const, content: req.prompt }];
      const result = await invokeChat(
        ep,
        {
          invocationId,
          model,
          messages,
          tools: req.tools ?? [],
          systemPrompt,
        },
        (text) => send({ type: 'token', invocationId, token: text }),
      );
      deps.settings.addCost(result.costUsd);
      send({ type: 'done', invocationId, content: result.content, costUsd: result.costUsd });
      return okResult({ invocationId, costUsd: result.costUsd });
    } catch (err) {
      const message = (err as Error).message;
      send({ type: 'error', invocationId, message });
      return failResult('invoke_failed', message);
    }
  });
}

function sendUndoToast(tool: string, invocationId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:undo-available', { tool, invocationId });
  }
}

export function bindAiDeps(d: HandlerDeps): void {
  deps = d;
}

export type { HandlerDeps };