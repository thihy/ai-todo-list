// IPC handlers for AI channels.
// ai.ask streams events via 'ai:stream'; ai.health / ai.models / ai.cancel
// (and ai.conversation.*) are non-streaming.
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
import { resolveEndpoint, healthCheck } from '../dsh/endpoints';
import { getDshRuntime, answerUserQuestion, answerUserApproval, type DshRuntimeDeps } from '../dsh/dsh-runtime';
import { costForUsage } from '../dsh/pricing';
import { SettingsStore } from '../settings/store';
import { BrowserWindow, dialog } from 'electron';
import { logger } from '../logger';
import type { AIStreamEvent } from '../../shared/ai-types';
import type { DataScope } from '../../shared/todo-list-api';
import { TodoRepo } from '../db/todo-repo';
import { ConversationRepo } from '../db/conversation-repo';
import { MarkdownStore } from '../files/markdown';
import { DrawingStore } from '../files/drawings';
import { DocumentStore } from '../files/documents';
import type Database from 'better-sqlite3';

interface HandlerDeps {
  dsh: DshHandle;
  settings: SettingsStore;
  repo: TodoRepo;
  conversations: ConversationRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  /** DocumentStore — used by the DSH runtime's `app.currentContext` tool. */
  docs: DocumentStore;
  /** Raw better-sqlite3 handle — used by the AI tool surface for raw
   *  inbox_attachments INSERTs (mirrors inbox.attach IPC). */
  db: Database.Database;
  /** Absolute path to the directory where inbox attachments are copied
   *  on disk; used by the AI tool surface for inbox.attach / attachBlob. */
  attachmentsDir: string;
}

let deps: HandlerDeps | null = null;

/** L4-H: build the DshRuntimeDeps from the current bound `deps`. Used by
 *  every `ai.*` and `ai.conversation.*` handler that needs the runtime,
 *  so we don't have to spell out the 9-field object literal at every call
 *  site. The runtime is single-instance (see dsh-runtime.ts:runtimePromise)
 *  so the cost of constructing the closure on every call is negligible. */
function buildRuntimeDeps(): DshRuntimeDeps | null {
  if (!deps) return null;
  return {
    getEndpoint: () => resolveEndpoint(deps!.settings.get()),
    repo: deps.repo,
    md: deps.md,
    drawings: deps.drawings,
    docs: deps.docs,
    conversations: deps.conversations,
    db: deps.db,
    attachmentsDir: deps.attachmentsDir,
    settings: deps.settings,
  };
}

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
      const runtime = await getDshRuntime(buildRuntimeDeps()!);
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

    // L4-E: model id for pricing is resolved from the same endpoint the runtime
    // will use; pricing lives in ../dsh/pricing.ts and is null for unknown
    // models (costUsd collapses to 0 — never fabricated).
    const pricingModel = ep.model ?? 'deepseek-chat';
    // Narrowed local: the early `if (!deps)` guards above have already proven
    // this is non-null for the rest of the handler, but TS doesn't carry that
    // into nested callbacks. Using a const alias keeps the narrowing local and
    // lets the `case 'done'` branch call `d.settings.addCost(...)` safely.
    const d = deps!;

    // DSH agent-loop path is the SOLE AI path (tool-calling). There is no
    // text-only client.ts fallback: if the runtime did not boot, surface the
    // error to the renderer instead of silently degrading. A null runtime means
    // DSH boot failed (see dsh-runtime.ts getDshRuntime — it logs the cause).
    const runtime = await getDshRuntime(buildRuntimeDeps()!);
    if (!runtime) {
      const message = 'DSH runtime unavailable — agent loop did not boot. Check logs (main process).';
      send({ type: 'error', invocationId, message });
      return failResult('dsh_unavailable', message);
    }

    // L4-E: running cost for this turn. Updated after runTurn resolves,
    // using the tokens the runtime accumulated from the raw DSH event stream.
    let costUsd = 0;
    // L5-A: the wire is now raw DSH session events (passthrough), not a
    // synthesized toolCall blob. Renderer owns the tool/call ↔ tool/result
    // merge (useAiStream), so this layer no longer keeps a `liveCallMeta`
    // map. The only main-side side effect is `app:data-changed` —
    // broadcasts fire from `tool/call` (we know the toolName there) so
    // we don't need to wait for the matching result.

    try {
      const turnResult = await runtime.runTurn({
        prompt: req.prompt,
        conversationId: req.conversationId,
        invocationId,
        onEvent: (e) => {
          // 透传：所有 DSH 事件原样发给渲染端。渲染端 useAiStream 负责把
          // assistant/chunk 转成 token/reasoning、把 tool/call + tool/result
          // 合并成 toolCall 事件。mutating-scope 检测从 result 阶段挪到
          // call 阶段（toolName 已知），少一次合并查表。
          send({ type: 'sessionEvent', invocationId, event: e });
          if (e?.type === 'tool/call') {
            const d = e.data as { name?: string } | undefined;
            const name = d?.name;
            if (name) {
              const scope = mutatingScope(name);
              if (scope) {
                broadcastDataChanged(scope);
              } else {
                // Unknown successful tool call — broadcast a broad 'todos'
                // signal as a safety net so future tools added without a
                // mutatingScope() entry still cause the most-critical
                // surfaces (task list / detail header) to refresh. Tools
                // that should ONLY touch content/drawings should declare so
                // explicitly above; this fallback only kicks in for tools
                // the map has never heard of.
                broadcastDataChanged('todos');
              }
            }
          }
        },
      });

      // L4-E：算价格并广播 settings-changed。当 dsh-runtime 不再合成 'done'
      // 事件，价格计算从流事件挪到 runTurn resolve 之后，依赖其返回的
      // tokensIn / tokensOut / content 三个值。
      costUsd = costForUsage(pricingModel, {
        inputTokens: turnResult.tokensIn,
        outputTokens: turnResult.tokensOut,
      });
      if (costUsd > 0) {
        d.settings.addCost(costUsd);
        logger.info(`turn cost: $${costUsd.toFixed(6)} (${turnResult.tokensIn}↑ / ${turnResult.tokensOut}↓ ${pricingModel})`);
        // Notify any open SettingsPane / Statusbar to re-fetch
        // monthlyCostUsd. Without this the UI shows stale cost
        // until the user reopens settings.
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('app:settings-changed', {});
        }
      }
      send({ type: 'done', invocationId, content: turnResult.content, costUsd, tokensOut: turnResult.tokensOut, tokensIn: turnResult.tokensIn });
      // Bump updated_at so the sidebar sorts this conversation to the top.
      // Cheap: a single UPDATE; no event broadcasting needed (the renderer
      // can re-list when it next focuses the conversation list).
      deps.conversations.touch(req.conversationId);

      // L3-D auto-rename is now handled by the DSH session-title service
      // (mounted via @deepseek-ai/dsh-session-title + the
      // @deepseek-ai/dsh-session-title-first-prompt-llm provider in
      // resources/dsh/cordis.yml). dsh-runtime.ts bridges the resulting
      // `session/title` events back into the conversations table; see the
      // permanent listener at the top of bootDsh().

      return okResult({ invocationId, costUsd, tokensOut: turnResult.tokensOut, content: turnResult.content });
    } catch (err) {
      const message = (err as Error).message;
      send({ type: 'error', invocationId, message });
      return failResult('invoke_failed', message);
    }
  });

  // ----- ai.conversation.* -----

  register('ai.conversation.list', async (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    try {
      const list = deps.conversations.list(req?.includeArchived === true);
      // L3-J: enrich each row with lastMessagePreview + messageCount from
      // the JSONL log. We load each conversation's history in parallel —
      // bounded by the conversation count, typically <100. Each load is a
      // zstd-decoded JSONL scan; fast enough that the round-trip latency
      // is dominated by fs reads, not model calls. For lists >200 rows
      // this becomes worth caching, but at that scale the user already
      // has L3-H search and we're past the affordance's intent.
      const enriched = await Promise.all(list.map(async (conv) => {
        try {
          const runtime = await getDshRuntime(buildRuntimeDeps()!);
          if (!runtime) return conv;
          const turns = await runtime.loadHistory({ conversationId: conv.id });
          if (turns.length === 0) return conv;
          // Last non-tool turn = the most recent user prompt or assistant
          // answer. Walk from the end so tool cards don't dominate the
          // preview (they're noisy and not what the user wants to scan).
          let lastPreview: string | undefined;
          for (let i = turns.length - 1; i >= 0; i--) {
            const t = turns[i]!;
            if (t.type === 'user') { lastPreview = t.text; break; }
            if (t.type === 'assistant') { lastPreview = t.text; break; }
            // tool turns are skipped — they're intermediate.
          }
          // messageCount = user + assistant turns (tools not counted).
          const messageCount = turns.filter((t) => t.type === 'user' || t.type === 'assistant').length;
          return { ...conv, lastMessagePreview: lastPreview, messageCount };
        } catch {
          // Per-row enrichment is best-effort — a torn log shouldn't
          // blank the whole list.
          return conv;
        }
      }));
      return Promise.resolve(okResult({ conversations: enriched }));
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
        const runtime = await getDshRuntime(buildRuntimeDeps()!);
        if (runtime) {
          await runtime.disposeConversation(req.id);
          // L3-G: also drop the on-disk JSONL log so a deleted conversation
          // doesn't leave a ghost under <DSH_SESSIONS_ROOT>. This is the
          // "and cleans JSONL" half of the L3-G contract. The previous
          // implementation left the log for later cleanup via Settings →
          // Data Directory; that was confusing — the user explicitly chose
          // delete, so honor it.
          const r = await runtime.removeSession(req.id);
          if (r.removed) logger.info(`conversation delete: also removed JSONL for ${req.id}`);
        }
      } catch (err) {
        // Non-fatal — the agent will be dropped on next dispose() anyway.
        console.warn('[ai.conversation.delete] runtime dispose failed:', (err as Error).message);
      }
      return okResult({ deleted });
    } catch (err) {
      return failResult('delete_failed', (err as Error).message);
    }
  });

  // L3-F: themed delete confirmation via dialog.showMessageBox. Replaces
  // the previous window.confirm() which renders an unthemed browser dialog
  // on Win11 — jarring against the rest of the app's chrome. The native
  // dialog inherits the OS theme (light/dark/high-contrast) and uses the
  // platform's standard warning presentation. Buttons are localised and
  // the destructive option is positioned second per platform convention
  // (Windows + macOS show destructive actions on the right).
  register('ai.conversation.confirmDelete', async (_e, req) => {
    try {
      if (!req?.id || !req?.title) return failResult('bad_request', 'id and title required');
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const result = await dialog.showMessageBox(win as never, {
        type: 'warning',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        title: '删除对话',
        message: `删除对话"${req.title}"？`,
        detail: '对话本身将从侧栏移除。其 AI 历史日志会保留在本地供后续清理（设置 → 数据目录）。',
        noLink: true,
      });
      return okResult({ confirmed: result.response === 1 });
    } catch (err) {
      return failResult('confirm_failed', (err as Error).message);
    }
  });

  register('ai.conversation.history', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.id) return failResult('no_conversation_id', 'id required');
    try {
      const runtime = await getDshRuntime(buildRuntimeDeps()!);
      if (!runtime) return okResult({ turns: [] });
      const turns = await runtime.loadHistory({ conversationId: req.id });
      return okResult({ turns });
    } catch (err) {
      return failResult('history_failed', (err as Error).message);
    }
  });

  // L4-G: human-in-the-loop answerers. The renderer posts here when the
  // user clicks an option on a UserQuestionCard / makes a decision on a
  // UserApprovalCard. We forward to the dsh-runtime answerer, which
  // resolves the pending waterfall promise; the in-flight DSH tool call
  // then receives the structured answer and proceeds.
  //
  // The runtime is single-handle-per-conversation, but multiple windows
  // may receive the request event for visibility — the answerer only
  // resolves the FIRST reply it sees (subsequent replies find no pending
  // entry and return ok:false). This matches the semantics in the
  // @deepseek-ai/dsh-user-questions upstream example, which is
  // single-answerer by construction.
  register('ai.userQuestion.answer', (_e, req) => {
    const reqId = req?.reqId;
    const answers = req?.answers;
    if (typeof reqId !== 'string' || !reqId) {
      return failResult('bad_request', 'reqId required');
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      return failResult('bad_request', 'answers must be a non-empty array');
    }
    for (const a of answers) {
      if (typeof a?.id !== 'string' || !a.id) {
        return failResult('bad_request', 'every answer needs an id');
      }
      if (!Array.isArray(a.selected)) {
        return failResult('bad_request', 'answer.selected must be an array of labels');
      }
    }
    const ok = answerUserQuestion(reqId, answers);
    if (!ok) {
      // The pending entry is gone (timeout, already-answered, runtime
      // torn down). The renderer will display "已超时" via the
      // ai:user-question-timeout event, so we just acknowledge here.
      return okResult({ ok: true });
    }
    return okResult({ ok: true });
  });

  register('ai.userApproval.answer', (_e, req) => {
    const reqId = req?.reqId;
    const decision = req?.decision;
    if (typeof reqId !== 'string' || !reqId) {
      return failResult('bad_request', 'reqId required');
    }
    if (decision !== 'allow-once' && decision !== 'reject') {
      return failResult('bad_request', "decision must be 'allow-once' or 'reject'");
    }
    const ok = answerUserApproval(reqId, decision);
    if (!ok) return okResult({ ok: true });
    return okResult({ ok: true });
  });
}

export function bindAiDeps(d: HandlerDeps): void {
  deps = d;
}

export type { HandlerDeps };

/** Map an AI tool name to the data scope it mutates (null = read-only/no refresh).
 *  The `conversations` scope is also updated by the DSH session-title listener in
 *  dsh-runtime.ts (it pushes app:data-changed directly), but we still keep the
 *  map here as the single source of truth so adding a new mutating tool is a
 *  one-line change. */
function mutatingScope(name: string): DataScope | null {
  switch (name) {
    case 'todo.create':
    case 'todo.update':
    case 'todo.delete':
    case 'todo.restore':
    case 'todo.batchUpdate':
      return 'todos';
    case 'content.writeBody':
    case 'content.restoreVersion':
      return 'content';
    case 'drawing.save':
    case 'drawing.delete':
    case 'drawing.rename':
    case 'drawing.setThumb':
      return 'drawings';
    case 'document.create':
    case 'document.remove':
    case 'document.rename':
      return 'content';
    case 'progress.log':
      return 'todos';
    case 'inbox.attach':
    case 'inbox.attachBlob':
    case 'inbox.remove':
      return 'content';
    case 'conversation.create':
    case 'conversation.rename':
    case 'conversation.archive':
    case 'conversation.unarchive':
    case 'conversation.delete':
      return 'conversations';
    default:
      return null;
  }
}