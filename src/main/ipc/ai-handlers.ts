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
import { getDshRuntime, peekDshRuntime, answerUserQuestion, answerUserApproval, grantSessionTool, revokeSessionTool, listSessionGranted, type DshRuntimeDeps } from '../dsh/dsh-runtime';
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
    // STARTUP-AI-ASYNC-002: short-circuit on `peekDshRuntime` instead of
    // calling `getDshRuntime` — cancel during cold-boot would otherwise
    // trigger a second boot path. The renderer UI already blocks cancel
    // while ai.status is loading, so this code path is only reached for
    // a stale renderer / RPC race.
    if (!peekDshRuntime()) return failResult('ai_not_ready', 'DSH not initialised');
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

    // Validate intent up-front so a typo from a future caller can't leak
    // into the runtime's envelope encoding (only `'create-task'` flips the
    // wire; anything else — including a bad value — falls back to chat).
    const intent: 'chat' | 'create-task' | undefined =
      req.intent === 'create-task' ? 'create-task'
      : req.intent === 'chat' ? 'chat'
      : undefined;

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
    //
    // STARTUP-AI-ASYNC-002: use the synchronous peek so this handler does
    // NOT trigger a fresh boot when the renderer calls ai.ask while the
    // splash-gated cold-boot is still in flight. The renderer UI blocks
    // submit while ai.status === 'loading' (see AIPane); this is the
    // defence-in-depth gate so a stale event / hot-key / external API
    // caller can't accidentally wake up a 22 s boot path. If peek says
    // null we return `ai_not_ready`; the renderer sees it as a transient
    // error and can surface "AI 仍在启动，请稍候".
    const peeked = peekDshRuntime();
    if (!peeked) return failResult('ai_not_ready', 'DSH still booting — try again once the AI panel shows ready');
    const runtime = peeked;

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
        intent,
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
      // STARTUP-DSH-001: list is now a pure SQLite metadata scan. The
      // previous implementation enriched every row with `loadHistory()`,
      // which spawned one JSONL read per conversation. On a workspace
      // with N sessions (including L3-C orphans that existed before the
      // DB row existed), the first ai.conversation.list() after splash
      // could scan every session log — blocking the AI pane and, on
      // Windows, tripping "Application Not Responding". The renderer
      // already declares `lastMessagePreview` / `messageCount` as
      // optional; until they're re-introduced via a dedicated per-row
      // hydration endpoint, they're simply absent. The history menu
      // already hides both when either is missing.
      //
      // 「显示更多」分页：limit/offset 由 ConversationRepo 内部夹紧；返回
      // total + remaining 让渲染端判断是否还有可加载页。
      const includeArchived = req?.includeArchived === true;
      const offset = req?.offset ?? 0;
      const total = deps.conversations.count(includeArchived);
      const conversations = deps.conversations.list({
        includeArchived,
        limit: req?.limit,
        offset,
      });
      const remaining = Math.max(0, total - offset - conversations.length);
      return Promise.resolve(okResult({ conversations, total, remaining }));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('ai.conversation.create', (_e, req) => {
    if (!deps) return Promise.resolve(failResult('ai_not_ready', 'DSH not initialised'));
    try {
      const conv = deps.conversations.create({ title: req?.title });
      // 容量上限：创建后立即按 updated_at ASC 删最老的，直到未归档数 ≤ 上限。
      // maxConversations = 0 表示不限，跳过 sweep。sweep 只动 DB 不动 JSONL
      // （纯 DB 操作，不依赖 runtime，避免阻塞 create 路径）。
      const max = deps.settings.get().maxConversations;
      if (max > 0) {
        const removed = deps.conversations.sweep(max);
        if (removed > 0) {
          logger.info(`conversation sweep: removed ${removed} old row(s) to stay under cap ${max}`);
          // 广播 data-changed 让所有窗口的 AIPane 列表自动刷新
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope: 'conversations' });
          }
        }
      }
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

  // 批量硬删：删多行 DB + 各自 JSONL 日志（沿用 L3-G 模式）。
  // 与 ai.conversation.delete 不同的点：
  //   1) DB 走单条 IN(...) SQL，事务原子；
  //   2) JSONL 清理是顺序 await 多个 disposeConversation/removeSession，
  //      任何一个失败只 warn 不中断其余（部分清理也优于整批回滚）。
  // 上限 200：超过会 fail('too_many')，避免一次发起的 IPC 太大撑爆内存
  // 或锁太久 DB。
  register('ai.conversation.deleteMany', async (_e, req) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!Array.isArray(req?.ids) || req.ids.length === 0) {
      return failResult('bad_request', 'ids required');
    }
    if (req.ids.length > 200) {
      return failResult('too_many', 'cannot delete more than 200 at once');
    }
    try {
      const deleted = deps.conversations.deleteMany(req.ids);
      // JSONL 清理：参考 ai.conversation.delete 的 L3-G 模式。
      // 整体 wrap 在 try 里，runtime 不可用或 per-id 失败都不影响 DB 删除。
      try {
        const runtime = await getDshRuntime(buildRuntimeDeps()!);
        if (runtime) {
          for (const id of req.ids) {
            try {
              await runtime.disposeConversation(id);
              await runtime.removeSession(id);
            } catch (e) {
              console.warn(`[ai.conversation.deleteMany] JSONL cleanup failed for ${id}:`, (e as Error).message);
            }
          }
        }
      } catch (e) {
        console.warn('[ai.conversation.deleteMany] runtime unavailable:', (e as Error).message);
      }
      // 广播让所有窗口的列表自动刷新（与 ai.ask 的 broadcastDataChanged 行为一致）
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope: 'conversations' });
      }
      return okResult({ deleted });
    } catch (err) {
      return failResult('delete_many_failed', (err as Error).message);
    }
  });

  // 批量删除的主题化 confirm：与 ai.conversation.confirmDelete 同一模式，
  // 但 message 用 count、detail 里塞前 3 个 titles 作为示例。
  register('ai.conversation.confirmDeleteMany', async (_e, req) => {
    try {
      const count = typeof req?.count === 'number' && req.count > 0 ? req.count : 0;
      if (count === 0) return failResult('bad_request', 'count required');
      const titles = Array.isArray(req?.titles)
        ? req.titles.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : [];
      const preview = titles.length > 0
        ? `（含：${titles.slice(0, 3).map((t) => `"${t}"`).join('、')}${titles.length > 3 ? ' 等' : ''}）`
        : '';
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const result = await dialog.showMessageBox(win as never, {
        type: 'warning',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        title: '批量删除对话',
        message: `删除选中的 ${count} 条对话？`,
        detail: `将被永久移除${preview}。其 AI 历史日志会一并清理。`,
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
    // STARTUP-AI-ASYNC-002 — synchronously peek; do NOT trigger a fresh
    // boot from this handler. AIPane gates its history effect on
    // ai.status === 'ready', so we shouldn't normally get here during
    // cold-boot, but a stale StrictMode-double effect could fire this
    // once. Return `ai_not_ready` rather than empty turns so the
    // renderer's effect re-runs once ready flips true (empty turns
    // would silently become "loaded").
    const peeked = peekDshRuntime();
    if (!peeked) return failResult('ai_not_ready', 'DSH still booting');
    const runtime = peeked;
    try {
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

  // Tag-input popover uses this as a fire-and-forget hint. STRICTLY advisory:
  // every failure path collapses to `{tags: []}` so the renderer's popover
  // never blocks on the AI. The renderer drops the response if the user closes
  // the popover or switches tasks before it lands (request id), so we don't
  // need an explicit cancellation channel here.
  const SUGGEST_TIMEOUT_MS = 5_000;
  const SUGGEST_DEFAULT_LIMIT = 4;
  const SUGGEST_MAX_LIMIT = 8;

  function clampSuggestLimit(req: unknown): number {
    if (typeof req !== 'number' || !Number.isFinite(req)) return SUGGEST_DEFAULT_LIMIT;
    const n = Math.floor(req);
    if (n <= 0) return SUGGEST_DEFAULT_LIMIT;
    return Math.min(n, SUGGEST_MAX_LIMIT);
  }

  function normalizeSuggestedTags(raw: unknown, existing: Set<string>, limit: number): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      // 中文标签 toLowerCase 是 no-op;历史英文标签仍然被规范成小写比较,
      // 同一个中/英 tag 在大小写无关维度上重复返回会被 seen 去重。
      const norm = item.trim().replace(/^#/, '').toLowerCase();
      if (!norm) continue;
      if (seen.has(norm)) continue;
      if (existing.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Pull a JSON array out of the model's text. Most models return clean JSON
   *  for a strong prompt, but a defensive `[…]` extraction fallback handles
   *  cases where the model wraps its answer in a markdown fence or appends a
   *  one-line rationale after the array. */
  function parseTagsFromText(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
    const m = trimmed.match(/\[[^\[\]]*\]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }

  /** One-shot non-streaming chat completion across the three protocols the
   *  app supports (openai / openresponses / anthropic). Returns the raw text
   *  of the model's first message, or null on any structural problem —
   *  callers treat null and `[]` the same way (advisory, no error path). */
  async function callNonStreamingChat(
    ep: { protocol: 'openai' | 'openresponses' | 'anthropic'; baseUrl: string; apiKey: string; model: string },
    systemMsg: string,
    userMsg: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const baseUrl = ep.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url: string;
    let body: unknown;

    if (ep.protocol === 'anthropic') {
      url = `${baseUrl}/v1/messages`;
      headers['x-api-key'] = ep.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: ep.model,
        max_tokens: 256,
        system: systemMsg,
        messages: [{ role: 'user', content: userMsg }],
      };
    } else if (ep.protocol === 'openresponses') {
      url = `${baseUrl}/responses`;
      if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
      body = {
        model: ep.model,
        input: `${systemMsg}\n\n${userMsg}`,
        max_output_tokens: 256,
        stream: false,
      };
    } else {
      url = `${baseUrl}/chat/completions`;
      if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
      body = {
        model: ep.model,
        stream: false,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
      };
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      logger.warn(`suggestTags: HTTP ${res.status} from ${url}`);
      return null;
    }
    const data = (await res.json()) as unknown;

    if (ep.protocol === 'anthropic') {
      const content = (data as { content?: Array<{ type: string; text?: string }> }).content;
      if (!Array.isArray(content)) return null;
      const text = content.find((b) => b?.type === 'text' && typeof b.text === 'string')?.text;
      return typeof text === 'string' ? text : null;
    }
    if (ep.protocol === 'openresponses') {
      const output = (data as { output?: Array<{ content?: Array<{ type: string; text?: string }> }> }).output;
      if (!Array.isArray(output)) return null;
      for (const item of output) {
        const parts = item?.content;
        if (Array.isArray(parts)) {
          const text = parts.find((p) => p?.type === 'output_text' && typeof p.text === 'string')?.text;
          if (typeof text === 'string') return text;
        }
      }
      return null;
    }
    // openai (DeepSeek, OpenAI, Ollama, anything OpenAI-compatible)
    const choice = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          const t = (part as { text?: string }).text;
          if (typeof t === 'string') parts.push(t);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    return null;
  }

  register('ai.suggestTags', async (_e, req) => {
    // Missing context / unconfigured endpoint → silent empty. The popover's
    // AI section is rendered as "no recs" in that case, which is fine and
    // avoids polluting the log on every popover open.
    const title = typeof req?.title === 'string' ? req.title.trim() : '';
    if (!title) return okResult({ tags: [] });
    if (!deps) return okResult({ tags: [] });
    const ep = resolveEndpoint(deps.settings.get());
    if (!ep) return okResult({ tags: [] });

    const limit = clampSuggestLimit(req?.limit);
    const existing = new Set<string>();
    if (Array.isArray(req?.existingTags)) {
      for (const t of req.existingTags) {
        if (typeof t === 'string' && t.trim()) {
          existing.add(t.trim().replace(/^#/, '').toLowerCase());
        }
      }
    }

    const systemMsg =
      '你是一个中文个人 todo 列表的标签推荐助手。' +
      '只返回一个 JSON 数组,内容是简短的中文标签(2~6 个汉字或常见短词,如"工作"/"家庭"/"紧急")。' +
      '不要使用英文单词、不要 markdown、不要解释、不要标点。';
    const bodyChunk =
      typeof req?.body === 'string' && req.body.trim().length > 0
        ? `\n正文: ${req.body.trim().slice(0, 1200)}`
        : '';
    const userMsg =
      `标题: ${title}${bodyChunk}\n\n` +
      `最多推荐 ${limit} 个标签。已存在的标签(避开): ${Array.from(existing).join(', ') || '(无)'}。` +
      `只返回 JSON 数组,例如 ["工作","紧急"]。`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
    try {
      const text = await callNonStreamingChat(ep, systemMsg, userMsg, controller.signal);
      if (!text) return okResult({ tags: [] });
      const parsed = parseTagsFromText(text);
      const tags = normalizeSuggestedTags(parsed, existing, limit);
      return okResult({ tags });
    } catch (err) {
      logger.warn(`suggestTags: ${(err as Error).message}`);
      return okResult({ tags: [] });
    } finally {
      clearTimeout(timer);
    }
  });

  // ===== OPENSPEC §ai-assistant Persistent and session tool grants =====
  //
  // 4 个新通道：
  //   - ai.userApproval.grantAlways({ reqId, toolName })
  //       把工具加进 settings.aiGrantedTools（持久化）并 resolve 当前 waterfall
  //       为 'allowed-once'，用户不再被问。渲染端的"始终允许此工具"按钮触发。
  //   - ai.userApproval.grantSession({ reqId, toolName, conversationId })
  //       写入 sessionGrantsByConv（内存态）并 resolve 当前 waterfall。会话
  //       结束 / disposeConversation 时随清空。渲染端的"本次会话允许"按钮触发。
  //   - ai.tools.listGranted({ conversationId })
  //       返回 always + 当前会话 session 的工具列表，settings UI 用它做
  //       "AI 工具授权"页。
  //   - ai.tools.revoke({ toolName, scope, conversationId? })
  //       从 settings 或 session Map 删一条授权；下一次同工具的 approval
  //       请求会重新落到 PendingApprovalCard。
  register('ai.userApproval.grantAlways', async (_e, req: { reqId: string; toolName: string }) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.toolName || !req?.reqId) {
      return failResult('bad_request', 'toolName and reqId are required');
    }
    const prev = deps.settings.get().aiGrantedTools;
    // 写持久化表（settings.patch 自动 persist）；不影响其他工具的授权
    deps.settings.patch({ aiGrantedTools: { ...prev, [req.toolName]: 'always' } });
    // 直接 resolve 当前 waterfall，渲染端不需要再调一次 allow-once
    const settled = answerUserApproval(req.reqId, 'allow-once');
    return okResult({ ok: true, reqId: req.reqId, persisted: true, settled });
  });

  register('ai.userApproval.grantSession', async (_e, req: { reqId: string; toolName: string; conversationId: string }) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.toolName || !req?.reqId || !req?.conversationId) {
      return failResult('bad_request', 'toolName, reqId and conversationId are required');
    }
    grantSessionTool(req.conversationId, req.toolName);
    const settled = answerUserApproval(req.reqId, 'allow-once');
    return okResult({ ok: true, reqId: req.reqId, persisted: false, settled });
  });

  register('ai.tools.listGranted', async (_e, req: { conversationId?: string }) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    const settings = deps.settings.get();
    const always = Object.entries(settings.aiGrantedTools)
      .filter(([, scope]) => scope === 'always')
      .map(([toolName]) => toolName);
    const session = req?.conversationId ? listSessionGranted(req.conversationId) : [];
    return okResult({ always, session });
  });

  register('ai.tools.revoke', async (_e, req: { toolName: string; scope: 'always' | 'session'; conversationId?: string }) => {
    if (!deps) return failResult('ai_not_ready', 'DSH not initialised');
    if (!req?.toolName) return failResult('bad_request', 'toolName is required');
    if (req.scope === 'always') {
      const prev = deps.settings.get().aiGrantedTools;
      if (prev[req.toolName] !== 'always') {
        return okResult({ ok: true, revoked: false, scope: 'always' });
      }
      // 不修改其他字段；spread + delete 保持其它工具的授权不变
      const next = { ...prev };
      delete next[req.toolName];
      deps.settings.patch({ aiGrantedTools: next });
      return okResult({ ok: true, revoked: true, scope: 'always' });
    }
    if (req.scope === 'session') {
      if (!req.conversationId) {
        return failResult('bad_request', 'conversationId is required for scope=session');
      }
      const revoked = revokeSessionTool(req.conversationId, req.toolName);
      return okResult({ ok: true, revoked, scope: 'session' });
    }
    return failResult('bad_request', `unknown scope ${String(req?.scope)}`);
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
 *  one-line change.
 *
 *  历史：早期版本用带点名字（`todo.create`），与 DSH tool registry（下划线
 *  名）脱节，case 永远 miss，所有 mutate 都走 default → null → 不广播。
 *  这是「ai.ask 后左栏不刷新」的根因之一（另一个根因是会话级 agent 在
 *  detach / resume 之间的 stream listener 链路，详见 attachLiveListener
 *  注释）。改名与 registerDomainTools 一一对应。 */
function mutatingScope(name: string): DataScope | null {
  switch (name) {
    case 'todo_create':
    case 'todo_update':
    case 'todo_delete':
    case 'todo_restore':
    case 'todo_batchUpdate':
    case 'todo_planForToday':
    case 'todo_unplan':
      return 'todos';
    case 'content_writeBody':
    case 'content_restoreVersion':
      return 'content';
    case 'drawing_save':
    case 'drawing_delete':
    case 'drawing_setThumb':
      return 'drawings';
    case 'conversation_create':
    case 'conversation_rename':
    case 'conversation_archive':
    case 'conversation_unarchive':
    case 'conversation_delete':
      return 'conversations';
    // DSH 自带的 fs / shell 工具（`write` / `edit` / `bash` / `pwsh` /
    // `grep` / `glob` / `read` / `read_image`）一律返回 null：它们修改
    // 的是 dsh_workspace 下的文件，不在我们的 store；broadcast
    // app:data-changed 渲染端无 handler，纯 no-op。还不如别推。
    case 'write':
    case 'edit':
    case 'bash':
    case 'pwsh':
    case 'grep':
    case 'glob':
    case 'read':
    case 'read_image':
      return null;
    default:
      return null;
  }
}