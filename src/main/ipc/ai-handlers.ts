// IPC handlers for AI channels.
// ai.invoke streams events via 'ai:stream'; ai.health / ai.models / ai.cancel are non-streaming.
//
// L2 multi-conversation architecture:
//   - Each user-controlled conversation maps 1:1 to a DSH SessionId (persisted
//     by dsh-session-persistence-jsonl) and to a cached agent handle in
//     src/main/dsh/dsh-runtime.ts.
//   - ai.ask REQUIRES conversationId; main validates the row exists in the
//     conversations table (DB v3) before touching the runtime.
//   - ai.conversation.* handle the user-facing CRUD + history load.

import { register, okResult, failResult } from './router';
import type { DshHandle } from '../dsh/types';
import { resolveEndpoint, healthCheck } from '../dsh/client';
import { getDshRuntime } from '../dsh/dsh-runtime';
import { SettingsStore } from '../settings/store';
import { BrowserWindow } from 'electron';
import type { AIStreamEvent } from '../../shared/ai-types';
import type { DataScope } from '../../shared/thihy-api';
import { TodoRepo } from '../db/todo-repo';
import { ConversationRepo } from '../db/conversation-repo';
import { MarkdownStore } from '../files/markdown';
import { DrawingStore } from '../files/drawings';

interface HandlerDeps {
  dsh: DshHandle;
  settings: SettingsStore;
  repo: TodoRepo;
  conversations: ConversationRepo;
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

  register('ai.cancel', async (_e, req) => {
    // L2: cancel by conversationId. The runtime aborts the in-flight turn on
    // the cached agent for that conversation; no-op if no agent is alive.
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req.conversationId) return failResult('no_conversation_id', 'conversationId required');
    try {
      const runtime = await getDshRuntime({
        getEndpoint: () => resolveEndpoint(deps!.settings.get()),
        repo: deps.repo,
        md: deps.md,
        drawings: deps.drawings,
      });
      if (runtime) await runtime.cancel(req.conversationId);
      return okResult({ ok: true });
    } catch (err) {
      return failResult('cancel_failed', (err as Error).message);
    }
  });

  // Streaming "ask AI" used by the AIPane submit; main pushes stream events.
  register('ai.ask', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req.conversationId) {
      return failResult('no_conversation_id', 'conversationId required (call ai.conversation.create first)');
    }
    // Validate the conversation row exists. The DB row is the user-visible
    // truth; if the renderer tries to write to an id without a row, fail
    // loudly rather than silently creating one. Archived conversations are
    // NOT writable (the user can unarchive first).
    const conv = deps.conversations.get(req.conversationId);
    if (!conv) return failResult('unknown_conversation', `no conversation row for ${req.conversationId}`);
    if (conv.archived) return failResult('conversation_archived', `conversation ${req.conversationId} is archived`);

    const s = deps.settings.get();
    const ep = resolveEndpoint(s);
    if (!ep) return failResult('no_api_key', 'Set API key / baseURL in settings first');
    if (ep.protocol !== 'openai' || s.provider !== 'ollama') {
      if (!ep.apiKey) return failResult('no_api_key', 'Set API key in settings first');
    }

    // Use the caller-provided id so the renderer can match streamed token/done
    // events that arrive before this IPC response resolves.
    const invocationId = req.invocationId ?? crypto.randomUUID();

    const send = (event: AIStreamEvent): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ai:stream', event);
      }
    };
    // Push a coarse-grained data-changed event so the renderer's task list /
    // sidebar / inbox / stats re-fetch after the AI mutates the DB in the main
    // process. The AI tools run on the real repo (deps.repo), so without this
    // the left pane stays stale until the user navigates.
    const broadcastDataChanged = (scope: DataScope): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
      }
    };

    send({ type: 'start', invocationId });

    // DSH agent-loop path is the SOLE AI path (tool-calling). There is no
    // text-only client.ts fallback: if the runtime did not boot, surface the
    // error to the renderer instead of silently degrading. A null runtime means
    // DSH boot failed (see dsh-runtime.ts getDshRuntime — it logs the cause).
    const runtime = await getDshRuntime({
      getEndpoint: () => ep,
      repo: deps.repo,
      md: deps.md,
      drawings: deps.drawings,
    });
    if (!runtime) {
      const message = 'DSH runtime unavailable — agent loop did not boot. Check logs (main process).';
      send({ type: 'error', invocationId, message });
      return failResult('dsh_unavailable', message);
    }

    try {
      await runtime.runTurn({
        prompt: req.prompt,
        conversationId: req.conversationId,
        invocationId,
        onEvent: (e) => {
          switch (e.type) {
            case 'token':
              send({ type: 'token', invocationId, token: e.text });
              break;
            case 'reasoning':
              send({ type: 'reasoning', invocationId, text: e.text });
              break;
            case 'toolResult':
              // The renderer's AIToolCallEvent carries the completed call +
              // its result together; DSH splits call/result, so emit on result.
              send({ type: 'toolCall', invocationId, toolName: e.name, args: e.args, result: e.ok ? e.data : e.error, ok: e.ok });
              // If the tool mutated data, tell the renderer to refresh its stores.
              {
                const scope = mutatingScope(e.name);
                if (scope) broadcastDataChanged(scope);
              }
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
      // Bump updated_at so the sidebar sorts this conversation to the top.
      // Cheap: a single UPDATE; no event broadcasting needed (the renderer
      // can re-list when it next focuses the conversation list).
      deps.conversations.touch(req.conversationId);
      return okResult({ invocationId, costUsd: 0 });
    } catch (err) {
      const message = (err as Error).message;
      send({ type: 'error', invocationId, message });
      return failResult('invoke_failed', message);
    }
  });

  // ----- ai.conversation.* -----

  register('ai.conversation.list', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    try {
      const list = deps.conversations.list(req?.includeArchived === true);
      return Promise.resolve(okResult({ conversations: list }));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('ai.conversation.create', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    try {
      const conv = deps.conversations.create({ title: req?.title });
      return Promise.resolve(okResult({ conversation: conv }));
    } catch (err) {
      return Promise.resolve(failResult('create_failed', (err as Error).message));
    }
  });

  register('ai.conversation.rename', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    if (!req?.id) return Promise.resolve(failResult('no_conversation_id', 'id required'));
    try {
      const ok = deps.conversations.rename(req.id, req.title);
      if (!ok) return Promise.resolve(failResult('not_found', `conversation ${req.id} not found`));
      const conv = deps.conversations.get(req.id)!;
      return Promise.resolve(okResult({ conversation: conv }));
    } catch (err) {
      return Promise.resolve(failResult('rename_failed', (err as Error).message));
    }
  });

  register('ai.conversation.archive', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    if (!req?.id) return Promise.resolve(failResult('no_conversation_id', 'id required'));
    try {
      const ok = deps.conversations.archive(req.id);
      return Promise.resolve(okResult({ ok }));
    } catch (err) {
      return Promise.resolve(failResult('archive_failed', (err as Error).message));
    }
  });

  register('ai.conversation.unarchive', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    if (!req?.id) return Promise.resolve(failResult('no_conversation_id', 'id required'));
    try {
      const ok = deps.conversations.unarchive(req.id);
      return Promise.resolve(okResult({ ok }));
    } catch (err) {
      return Promise.resolve(failResult('unarchive_failed', (err as Error).message));
    }
  });

  register('ai.conversation.delete', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.id) return failResult('no_conversation_id', 'id required');
    try {
      const deleted = deps.conversations.delete(req.id);
      // Best-effort: dispose the runtime's cached agent for this conversation
      // so we don't keep an idle handle on a deleted row.
      try {
        const runtime = await getDshRuntime({
          getEndpoint: () => resolveEndpoint(deps!.settings.get()),
          repo: deps.repo,
          md: deps.md,
          drawings: deps.drawings,
        });
        if (runtime) await runtime.disposeConversation(req.id);
      } catch (err) {
        // Non-fatal — the agent will be dropped on next dispose() anyway.
        console.warn('[ai.conversation.delete] runtime dispose failed:', (err as Error).message);
      }
      return okResult({ deleted });
    } catch (err) {
      return failResult('delete_failed', (err as Error).message);
    }
  });

  register('ai.conversation.history', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.id) return failResult('no_conversation_id', 'id required');
    try {
      const runtime = await getDshRuntime({
        getEndpoint: () => resolveEndpoint(deps!.settings.get()),
        repo: deps.repo,
        md: deps.md,
        drawings: deps.drawings,
      });
      if (!runtime) return okResult({ turns: [] });
      const turns = await runtime.loadHistory({ conversationId: req.id });
      return okResult({ turns });
    } catch (err) {
      return failResult('history_failed', (err as Error).message);
    }
  });
}

export function bindAiDeps(d: HandlerDeps): void {
  deps = d;
}

export type { HandlerDeps };

/** Map an AI tool name to the data scope it mutates (null = read-only/no refresh). */
function mutatingScope(name: string): DataScope | null {
  switch (name) {
    case 'todo.create':
    case 'todo.update':
    case 'todo.delete':
      return 'todos';
    case 'content.writeBody':
    case 'content.restoreVersion':
      return 'content';
    case 'drawing.save':
    case 'drawing.delete':
    case 'drawing.setThumb':
      return 'drawings';
    default:
      return null;
  }
}