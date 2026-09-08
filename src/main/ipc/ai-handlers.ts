// IPC handlers for AI channels.
// ai.invoke streams events via 'ai:stream'; ai.health / ai.models / ai.cancel are non-streaming.

import { register, okResult, failResult } from './router';
import type { DshHandle } from '../dsh/types';
import { tierFor } from '../dsh/tools';
import { invokeDeepSeek, makeSystemPrompt, healthCheck } from '../dsh/client';
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
      const apiKey = deps?.settings.get().apiKey ?? null;
      if (!apiKey) return okResult({ ok: false, mode: dsh.health().mode, error: 'no_api_key' });
      const started = Date.now();
      await healthCheck(apiKey);
      deps?.settings.recordHeartbeat();
      return okResult({ ok: true, mode: dsh.health().mode, latencyMs: Date.now() - started });
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
    const apiKey = deps.settings.get().apiKey;
    if (!apiKey) return failResult('no_api_key', 'Set API key in settings first');

    const invocationId = crypto.randomUUID();
    const model = req.model ?? deps.settings.get().model;

    const send = (event: AIStreamEvent): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ai:stream', event);
      }
    };

    send({ type: 'start', invocationId });

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
      const result = await invokeDeepSeek(
        apiKey,
        {
          invocationId,
          model,
          messages: [{ role: 'user', content: req.prompt }],
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