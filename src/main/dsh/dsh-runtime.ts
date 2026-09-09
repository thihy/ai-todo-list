// DSH runtime — boots the in-process agent tree, registers our ThihyLlmAdapter
// for the 'thihy' provider route, registers our typed todo/content/drawing
// tool handlers, and exposes runTurn() to drive an agent turn and stream
// tokens + tool activity back to the renderer.
//
// Multi-conversation model (L2): each user-controlled conversation maps 1:1
// to a DSH session (persisted by dsh-session-persistence-jsonl) and to a
// cached agent handle. Different conversations run in parallel — the agent
// handle is cached for the conversation's lifetime, not created per turn.
// This gives the renderer three affordances the prior single-agent design
// couldn't:
//   1. User can switch conversations without losing prior turns (history
//      loads from the JSONL backend).
//   2. User can submit a new turn to conversation A while conversation B's
//      turn is still in flight — each agent has its own state and event
//      stream.
//   3. Deleting a conversation tears down its agent (no zombie handles).
//
// Event routing: ctx.on('session/event', ...) fires globally for ALL
// sessions, so each cached agent's listener filters by session.id and
// only forwards events for its own conversation. See ensureAgent().

import { app, BrowserWindow } from 'electron';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import type { ResolvedEndpoint } from './endpoints';
import { resolveEndpoint, healthCheck } from './endpoints';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { DocumentStore } from '../files/documents';
import { getFocus } from '../app-context';
import type { ConversationRepo } from '../db/conversation-repo';
import type { SettingsStore } from '../settings/store';
import type { TodoFilter, TodoStatus, TodoCreate, TodoPatch, Priority } from '../../shared/todo-types';
import { TODO_STATUSES, PRIORITIES } from '../../shared/todo-types';
import type { UserQuestionAnswer, UserQuestionRequest } from '../../shared/ai-types';
import type Database from 'better-sqlite3';
import { mimeExt, sanitizeName } from '../util/mime';

// DSH is imported dynamically so the main bundle stays buildable even before
// the packages are installed, and so a boot failure surfaces as an explicit
// "DSH unavailable" error to the renderer instead of crashing the app on import.
type DshContext = {
  get(key: string): unknown;
  on(event: string, handler: (...args: any[]) => void): () => void;
  fiber?: { dispose?(): Promise<void> };
  /** L4-G: cordis waterfall dispatch. Used by the ask_user_question /
   *  ask_user_approval tools to invoke the same listener chain we
   *  installed in bootDsh() for cross-pane consistency. The listener's
   *  promise IS the awaited value (we pass a no-op `next` that resolves
   *  to noAnswerer so the listener knows it's a direct call, not a
   *  nested one). */
  waterfall(event: string, ...args: unknown[]): Promise<unknown>;
};

export interface DshRuntimeDeps {
  getEndpoint: () => ResolvedEndpoint | null;
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  /** DocumentStore — used by the `app.currentContext` tool to enrich a
   *  document-kind focus pointer with the full task_documents row. */
  docs: DocumentStore;
  /** Required so the DSH session-title service can sync AI-generated titles
   *  back into the renderer's conversation list. Without this, titles stay
   *  in the session log and never appear in the sidebar. */
  conversations: ConversationRepo;
  /** Raw better-sqlite3 handle used ONLY for the inbox_attachments INSERT
   *  path. We keep this isolated from the typed repos because the inbox
   *  schema is intentionally narrow (no rich row class), and going through
   *  a new repo would just be a 5-line passthrough. */
  db: Database.Database;
  /** Absolute path to the directory where attached files / pasted images
   *  are copied. Created on first use (mkdir -p). */
  attachmentsDir: string;
  /** Settings store — the AI tool surface needs to know the active
   *  provider/model/connected state for the `ai.health` / `ai.models`
   *  tool implementations, and may need to read API keys for some
   *  self-debugging operations. */
  settings: SettingsStore;
}

// One rendered conversation item. Loaded from the JSONL backend via
// loadHistory() and also produced live by runTurn's onEvent callback.
// Designed to be the same shape the AIPane already renders (turn text +
// tool call/result chips + optional reasoning block), so the UI can treat
// "live turn" and "loaded history turn" identically.
export type HistoryTurn =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; reasoning?: string }
  | { type: 'tool'; name: string; args?: unknown; ok: boolean; data?: unknown; error?: string };

export type TurnEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; name: string; args: unknown }
  | { type: 'toolResult'; name: string; args?: unknown; ok: boolean; data?: unknown; error?: string }
  | { type: 'done'; content: string; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string };

export interface DshRuntime {
  runTurn(opts: {
    prompt: string;
    conversationId: string;
    invocationId: string;
    onEvent: (e: TurnEvent) => void;
    signal?: AbortSignal;
  }): Promise<{ content: string }>;
  /** Abort the in-flight turn on a conversation (no-op if idle/missing).
   *  L3-A: this is a SOFT cancel — the cached agent handle survives, so the
   *  next runTurn() reuses the same agent + persisted session JSONL without
   *  re-resuming from disk. Use disposeConversation() for hard removal. */
  cancel(conversationId: string): Promise<void>;
  /** Load this conversation's persisted history as a flat list of turns. */
  loadHistory(opts: { conversationId: string; signal?: AbortSignal }): Promise<HistoryTurn[]>;
  /** Drop the cached agent for one conversation (no-op if absent). */
  disposeConversation(conversationId: string): Promise<void>;
  /** L3-G: delete the on-disk JSONL log for a conversation (no-op if absent).
   *  Walks <DSH_SESSIONS_ROOT>/<project>/<id>/ recursively and removes it.
   *  The DB row is the renderer's concern (ConversationRepo.delete); we only
   *  own the durable log. Safe to call on an unknown id — returns silently. */
  removeSession(conversationId: string): Promise<{ removed: boolean }>;
  dispose(): Promise<void>;
}

let runtimePromise: Promise<DshRuntime | null> | null = null;

// ===== L4-G: Human-in-the-loop bridges =====
//
// DSH ships the user-questions + user-approval seams (@deepseek-ai/dsh-user-questions
// + @deepseek-ai/dsh-user-approval) but publishes no companion answerer package.
// We register waterfall listeners in bootDsh() that bridge every ask to the
// Electron renderer: each listener mints a reqId, sends the question/approval
// payload to every BrowserWindow, and awaits the structured answer via the
// `ai.userQuestion.answer` / `ai.userApproval.answer` IPC channels.
//
// 90s auto-cancel: the user might walk away mid-question. We don't want
// the agent loop to block forever, so each pending request installs a
// setTimeout that rejects with ASK_ABORTED (DSH's vocabulary). The
// renderer's inline card flips to a "已超时" state on the same timer
// firing — pushed via `ai:user-question-timeout` / `ai:user-approval-timeout`.
//
// All state lives at module scope (not on the runtime instance) because
// the IPC handlers in main/index.ts register BEFORE DSH boots — the
// router validates channels but the handlers need a way to resolve a
// pending waterfall promise whose runtime isn't available yet. The
// functions below are the answer-side of the bridge.

/** Maximum time we wait for the user's answer before auto-cancelling. */
const INTERACTION_TIMEOUT_MS = 90_000;

interface PendingQuestion {
  resolve: (a: UserQuestionAnswer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
interface PendingApproval {
  resolve: (o: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingQuestions = new Map<string, PendingQuestion>();
const pendingApprovals = new Map<string, PendingApproval>();

/** Called by main/index.ts's IPC handler when the renderer posts the
 *  structured answer to `ai.userQuestion.answer`. Returns false if the
 *  reqId has no pending entry (timed out, duplicate reply, etc).
 *  The renderer hands us the full { reqId, answers } so we resolve the
 *  waterfall promise with the same shape the DSH tool expects. */
export function answerUserQuestion(reqId: string, answers: UserQuestionAnswer['answers']): boolean {
  const entry = pendingQuestions.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingQuestions.delete(reqId);
  entry.resolve({ reqId, answers });
  return true;
}

/** Called by main/index.ts's IPC handler when the renderer posts the
 *  binary decision to `ai.userApproval.answer`. We map the renderer's
 *  simplified vocabulary ('allow-once' | 'reject') onto DSH's
 *  ApprovalOutcome ('allowed-once' | 'rejected'). 'cancelled' and
 *  'unavailable' are reserved for the timeout / no-answerer paths. */
export function answerUserApproval(reqId: string, decision: 'allow-once' | 'reject'): boolean {
  const entry = pendingApprovals.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingApprovals.delete(reqId);
  entry.resolve(decision === 'allow-once' ? 'allowed-once' : 'rejected');
  return true;
}

/** Cancel everything still pending — called from dispose() so a runtime
 *  tear-down doesn't leave zombie timers firing into nothing. */
function cancelAllPending(): void {
  for (const entry of pendingQuestions.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('ask_user_question was aborted before the user answered'));
  }
  pendingQuestions.clear();
  for (const entry of pendingApprovals.values()) {
    clearTimeout(entry.timer);
    entry.resolve('cancelled');
  }
  pendingApprovals.clear();
}

/** Build the UserQuestionRequest payload we'd push to the renderer.
 *  Pulled out so the waterfall listener below is one straight line. */
function questionRequestPayload(reqId: string, request: { questions: ReadonlyArray<{ id: string; question: string; detail?: string; header?: string; options?: ReadonlyArray<{ label: string; description?: string }>; multiSelect?: boolean }> }): UserQuestionRequest {
  return {
    reqId,
    // invocationId isn't on the DSH request shape; the renderer matches
    // via reqId alone. (Adding it would require plumbing the LLM adapter
    // through ctx.userQuestions.ask — not worth the complexity for an
    // already-correlated reqId.)
    invocationId: '',
    questions: request.questions.map((q) => ({
      id: q.id,
      question: q.question,
      detail: q.detail,
      header: q.header,
      options: q.options?.map((o) => ({ label: o.label, description: o.description })),
      multiSelect: q.multiSelect,
    })),
  };
}

/**
 * L3-C: Backfill DB rows for sessions that exist on disk under
 * <DSH_SESSIONS_ROOT> but have no entry in the `conversations` table.
 *
 * Why: pre-L2 the renderer didn't have a multi-conversation model, so
 * sessions were created on disk by the early DSH runtime / test-adapter
 * smoke runs without ever writing a row in `conversations`. After L2
 * those orphans would be invisible to the new AIPane sidebar — the JSONL
 * log survives, but no row means no UI affordance to load it.
 *
 * What this does: walks the persistence backend's session list, compares
 * against the DB row set, and for every orphan:
 *   1. Loads the session's events via persistence.load(id)
 *   2. Extracts the FIRST user/message text (DSH shape: data.content[] with
 *      {type:'text', text}) and uses it as the row title, truncated to
 *      TITLE_MAX with an ellipsis when longer.
 *   3. INSERTs a row with created_at = session.createdAt (the file mtime
 *      the persistence plugin captured when the session was first opened)
 *      and updated_at = Date.now() so the sidebar surfaces the new row at
 *      the top until the user actually uses it.
 *
 * Safe to call repeatedly: idempotent (skips ids that already have a row).
 * Runs after `bindAiDeps` so the migrated rows are visible on the first
 * AIPane mount — no need for a separate refresh.
 *
 * Title heuristic: the FIRST user prompt is the most stable signal of
 * intent. We don't try to update later — that's L3-D (auto-rename after
 * first turn). Orphans whose first user message is empty (rare — happens
 * when the session was opened but no message was sent) fall back to the
 * default `未命名对话` title so the user still sees something.
 */
export async function migrateOrphanSessions(conversations: ConversationRepo): Promise<void> {
  const TITLE_MAX = 24;
  const persistence = await bootPersistenceOnly();
  if (!persistence) {
    logger.warn('migrateOrphanSessions: persistence plugin unavailable; skipping');
    return;
  }
  const list = await persistence.list();
  if (list.length === 0) {
    logger.info('migrateOrphanSessions: 0 sessions on disk; nothing to migrate');
    return;
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of list) {
    if (conversations.get(entry.id)) {
      skipped++;
      continue;
    }
    // Load events to extract the first user message for the title.
    let title = '未命名对话';
    try {
      const loaded = await persistence.load(entry.id);
      const events = loaded?.events ?? [];
      const firstUser = extractFirstUserText(events);
      if (firstUser) title = truncateTitle(firstUser, TITLE_MAX);
    } catch (err) {
      logger.warn(`migrateOrphanSessions(${entry.id}): load failed, using default title: ${(err as Error).message}`);
    }
    try {
      const row = conversations.create({ title });
      // created_at should reflect the original session creation time, not
      // the migration time — otherwise the sidebar mis-orders pre-L2 chats
      // at the top instead of by their actual age. updated_at stays "now"
      // so the row floats to the top until the user interacts.
      // Patch created_at directly via the underlying handle: the public API
      // intentionally doesn't expose this (a backfill is the only case).
      (conversations as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('UPDATE conversations SET created_at = ? WHERE id = ?')
        .run(entry.createdAt, row.id);
      logger.info(`migrateOrphanSessions: backfilled ${row.id} "${title}" (created=${new Date(entry.createdAt).toISOString()})`);
      migrated++;
    } catch (err) {
      logger.warn(`migrateOrphanSessions(${entry.id}): insert failed: ${(err as Error).message}`);
      failed++;
    }
  }
  logger.info(`migrateOrphanSessions: ${migrated} migrated, ${skipped} already present, ${failed} failed (total ${list.length})`);
}

/** Truncate a title to maxChars; append "…" when truncated. */
function truncateTitle(s: string, maxChars: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + '…';
}

/** Pull the first user/message text out of a DSH event log. */
function extractFirstUserText(events: ReadonlyArray<{ type: string; data?: unknown }>): string {
  for (const ev of events) {
    if (ev.type !== 'user/message') continue;
    const d = ev.data as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = (d?.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text) return text;
  }
  return '';
}

// --- Migration helpers ---
//
// The migration needs access to the persistence layer's list/load, which
// lives inside the runtime boot. Rather than expose that as a public
// runtime method (it would couple the migration to runtime internals), we
// run a *second* boot of just the persistence layer — cheap, isolated,
// and gives the migration a clean handle.
//
// Why a second boot: the real runtime's `boot()` registers our LLM
// adapter and domain tools, which are not needed for a migration. A
// dedicated boot is ~50ms and zero side effects. The migration runs at
// app startup (after the user opens the app for the first time post-L2)
// and not on the hot path.

/** Boot a minimal cordis tree with just the session persistence plugin
 *  and return its list()/load() methods. Returns null on failure. */
async function bootPersistenceOnly(): Promise<{
  list: () => Promise<Array<{ id: string; createdAt: number }>>;
  load: (id: string) => Promise<{
    meta: { id: string };
    events: ReadonlyArray<{ type: string; data?: unknown }>;
  } | undefined>;
} | null> {
  try {
    const cfg = resolveAppPath('resources/dsh/cordis.yml');
    if (!cfg || !existsSync(cfg)) return null;
    const appRoot = app.getAppPath();
    const bareBase = new URL('.', pathToFileURL(appRoot).href).href;
    const bootMod = await import('@deepseek-ai/dsh-app-boot');
    const { boot } = bootMod;
    const ctx = (await boot('thihy-migrate', cfg, undefined, undefined, bareBase)) as DshContext;
    const persistence = ctx.get('sessionPersistence') as {
      list?: (signal?: AbortSignal) => Promise<Array<{ id: string; createdAt: number }>>;
      load?: (id: string, signal?: AbortSignal) => Promise<{
        meta: { id: string };
        events: ReadonlyArray<{ type: string; data?: unknown }>;
      } | undefined>;
    } | undefined;
    if (!persistence?.list || !persistence?.load) {
      await ctx.fiber?.dispose?.();
      return null;
    }
    return {
      list: () => persistence.list!(),
      load: (id) => persistence.load!(id),
    };
  } catch (err) {
    logger.warn(`bootPersistenceOnly failed: ${(err as Error).message}`);
    return null;
  }
}

/** Lazily boot DSH once; returns null if boot fails (the renderer surfaces
 *  this as an explicit "DSH unavailable" error — there is no fallback path). */
export function getDshRuntime(deps: DshRuntimeDeps): Promise<DshRuntime | null> {
  if (!runtimePromise) {
    runtimePromise = bootDsh(deps).catch((err) => {
      logger.warn(`DSH boot failed; ai.ask will report dsh_unavailable: ${(err as Error).message}`);
      runtimePromise = null;
      return null;
    });
  }
  return runtimePromise;
}

async function bootDsh(deps: DshRuntimeDeps): Promise<DshRuntime | null> {
  // Locate the cordis.yml + the installed package tree base.
  const cfg = resolveAppPath('resources/dsh/cordis.yml');
  if (!cfg || !existsSync(cfg)) {
    logger.warn('DSH cordis.yml not found; skipping boot');
    return null;
  }
  // bareModuleBaseUrl anchors bare @deepseek-ai/dsh-* specifiers to the
  // installed package tree. In dev that's the project root; in a packaged app
  // it's the app directory holding node_modules.
  const appRoot = app.getAppPath();
  const bareBase = new URL('.', pathToFileURL(appRoot).href).href;

  const bootMod = await import('@deepseek-ai/dsh-app-boot');
  const { boot } = bootMod;
  const ctx = (await boot('thihy', cfg, undefined, undefined, bareBase)) as DshContext;

  // Surface the durable session layer: list what's already persisted under
  // <DSH_SESSIONS_ROOT> (see src/main/index.ts for the env var setup) so the
  // user can see in the log how many prior conversations survive. The plugin
  // returns a header per stored session; we only count + log the ids.
  // Safe to call on every boot — list() walks the on-disk directory and
  // returns immutable metadata without loading full event logs.
  try {
    const persistence = ctx.get('sessionPersistence') as {
      list?: (signal?: AbortSignal) => Promise<Array<{ id: string; createdAt: number }>>;
      config?: { root?: string };
    } | undefined;
    if (persistence?.list) {
      const stored = await persistence.list();
      const root = persistence.config?.root ?? process.env['DSH_SESSIONS_ROOT'] ?? '(unset)';
      if (stored.length === 0) {
        logger.info(`DSH persistence: 0 sessions stored under ${root}`);
      } else {
        const ids = stored.map((s) => s.id).join(', ');
        logger.info(`DSH persistence: ${stored.length} session(s) stored under ${root}: ${ids}`);
      }
    }
  } catch (err) {
    // Don't fail boot on a list error — the persistence layer is best-effort
    // observability here, not a load-bearing dependency.
    logger.warn(`DSH persistence list failed (non-fatal): ${(err as Error).message}`);
  }

  // 1. Register our LLM adapter for the 'thihy' route.
  const llm = ctx.get('llm') as { registerAdapter(providers: string[], adapter: unknown): () => void } | undefined;
  if (!llm) throw new Error('DSH booted but ctx.llm is absent');
  const { ThihyLlmAdapter } = await import('./llm-adapter');
  const disposeAdapter = llm.registerAdapter(['thihy'], new ThihyLlmAdapter({ getEndpoint: deps.getEndpoint }));

  // 2. Register our typed domain tools.
  const tools = ctx.get('tools') as { register(def: unknown): () => void } | undefined;
  if (!tools) throw new Error('DSH booted but ctx.tools is absent');
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const disposeTools = registerDomainTools(tools, defineTool, deps, ctx);

  // 3. Conversation registry. One agent handle per conversation, cached for
  //    the conversation's lifetime. ensureAgent() idempotent: a second call
  //    for the same id returns the existing entry without recreating.
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const agentsApi = ctx.get('agents') as {
    create(o: unknown): Promise<{
      agent: {
        followup(m: unknown): void;
        whenIdle(): Promise<void>;
        /**
         * Soft cancel — abort the active turn without disposing the agent.
         * Per `@deepseek-ai/dsh-agent` runtime-types.d.ts (line 77-83):
         * "Clear queued and steering work — unless `keepInbox` — and abort the
         * active turn or between-turn task. The first cause wins for that
         * activity. With no active activity, cancellation is a no-op and does
         * not arm later work." This is exactly the L3-A contract: the agent
         * handle survives so the next followup() runs on the same agent and
         * the same persisted session JSONL.
         */
        cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }, options?: { keepInbox?: boolean }): void;
        id: unknown;
      };
      dispose(): Promise<void>;
    }>;
  } | undefined;
  if (!agentsApi) throw new Error('ctx.agents absent');

  // Permanent listener: every `session/title` event flowing through the DSH
  // runtime gets reflected into the local conversations DB so the renderer's
  // sidebar and switcher stay in sync. The DSH session-title service emits
  // these events in two cases:
  //   1. The deterministic fallback is created after the first eligible user
  //      message (truncated first-prompt snippet).
  //   2. The optional LLM provider (dsh-session-title-first-prompt-llm)
  //      completes its async summary — last event wins.
  // Both flow through here; we just rename whatever's in the DB to whatever
  // arrived, and broadcast app:data-changed { scope: 'conversations' } so the
  // AIPane / sidebar refresh without a manual re-list.
  ctx.on('session/event', (session: unknown, event: { type: string; data?: unknown }) => {
    if (event?.type !== 'session/title') return;
    const sid = (session as { id?: unknown } | undefined)?.id;
    if (sid == null) return;
    const conversationId = String(sid);
    const d = event.data as { title?: unknown; source?: { kind?: string } } | undefined;
    const title = typeof d?.title === 'string' ? d.title.trim() : '';
    if (!title) return;
    const existing = deps.conversations.get(conversationId);
    if (!existing) {
      // Session exists but no DB row yet — the renderer hasn't created it
      // (or migrateOrphanSessions is still in flight). Skip; the next
      // create() / migration will pick up the title from the session log.
      return;
    }
    if (existing.title === title) return;
    try {
      deps.conversations.rename(conversationId, title);
      logger.info(`DSH title sync ${conversationId}: "${existing.title}" → "${title}" (source=${d?.source?.kind ?? 'unknown'})`);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope: 'conversations' });
      }
    } catch (err) {
      logger.warn(`DSH title rename failed for ${conversationId}: ${(err as Error).message}`);
    }
  });

  // L4-G: human-in-the-loop bridges for DSH user-questions + user-approval.
  // DSH publishes no companion answerer for these seams; we install our own
  // waterfall listener so every ask() call from a tool (model-driven
  // ask_user_question) or ctx.approval.request() lands in the renderer as
  // an inline card. The listener mints a reqId, broadcasts to all windows,
  // and awaits the answer via the answerUserQuestion / answerUserApproval
  // IPC handlers. 90s auto-cancel so a user who walks away doesn't block
  // the agent loop forever.
  ctx.on('user-questions/request', (request: {
    questions: ReadonlyArray<{ id: string; question: string; detail?: string; header?: string; options?: ReadonlyArray<{ label: string; description?: string }>; multiSelect?: boolean }>;
  }, _next: () => Promise<unknown>): Promise<UserQuestionAnswer> => {
    const reqId = randomUUID();
    return new Promise<UserQuestionAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pendingQuestions.get(reqId);
        if (!entry) return; // already resolved
        pendingQuestions.delete(reqId);
        // Notify the renderer the card has timed out so it can flip to a
        // "已超时自动取消" state — keeps the UI honest about the agent's
        // effective state (the loop will receive ASK_ABORTED and proceed).
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('ai:user-question-timeout', { reqId });
        }
        reject(new Error('ask_user_question was aborted before the user answered'));
      }, INTERACTION_TIMEOUT_MS);
      pendingQuestions.set(reqId, { resolve, reject, timer });
      const payload = questionRequestPayload(reqId, request);
      logger.info(`DSH user-questions/request: reqId=${reqId} questions=${payload.questions.length}`);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ai:user-question-request', payload);
      }
    });
  });

  // Mirror for binary approvals. DSH user-approval normalizes the answerer
  // return value to one of four outcomes; we only ever resolve with
  // 'allowed-once' or 'rejected' from the renderer path (timeout yields
  // 'unavailable' via the timeout path, signal abort yields 'cancelled').
  ctx.on('approval/request', (req: {
    agent: { id?: unknown };
    toolName: string;
    callId?: unknown;
    reason?: string;
    signal?: AbortSignal;
  }, _next: () => Promise<unknown>): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> => {
    const reqId = randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && !signal.aborted) signal.removeEventListener('abort', onAbort);
        pendingApprovals.delete(reqId);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle('unavailable'), INTERACTION_TIMEOUT_MS);
      const signal = req.signal;
      const onAbort = (): void => settle('cancelled');
      if (signal) {
        if (signal.aborted) { settle('cancelled'); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pendingApprovals.set(reqId, { resolve: (o) => settle(o), reject: () => settle('unavailable'), timer });
      const expiresAtMs = Date.now() + INTERACTION_TIMEOUT_MS;
      logger.info(`DSH approval/request: reqId=${reqId} tool=${req.toolName} callId=${String(req.callId ?? '')}`);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('ai:user-approval-request', {
            reqId,
            invocationId: '',
            toolName: req.toolName,
            reason: req.reason ?? '',
            expiresAtMs,
          });
        }
      }
    });
  });

  const persistenceApi = ctx.get('sessionPersistence') as {
    load: (id: string, signal?: AbortSignal) => Promise<{
      meta: { id: string };
      inheritedEventCount: number;
      events: ReadonlyArray<{
        type: string;
        seq?: number;
        time?: number;
        data?: unknown;
      }>;
    } | undefined>;
    config?: { root?: string };
  } | undefined;

  interface ConversationEntry {
    id: string;
    agent: {
      followup(m: unknown): void;
      whenIdle(): Promise<void>;
      cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }, options?: { keepInbox?: boolean }): void;
      id: unknown;
    };
    disposeHandle: () => Promise<void>;
    /** Unsubscribe from the per-conversation session/event listener. */
    offSession: () => void;
    /** Latest fullText accumulated for the in-flight turn (for the 'done' event). */
    fullText: string;
    /** callId→{name, args} for this conversation, used to label tool/result events. */
    callMeta: Map<string, { name: string; args: string }>;
    /** When true, no live consumer is reading events (e.g. between turns). */
    dormant: boolean;
    /** L4-E: token totals for the in-flight turn, summed across steps from
     *  the assistant/message events. Reset at attachLiveListener() time. */
    turnTokensIn: number;
    turnTokensOut: number;
  }

  const conversations = new Map<string, ConversationEntry>();

  async function ensureAgent(conversationId: string, model: string): Promise<ConversationEntry> {
    const existing = conversations.get(conversationId);
    if (existing) return existing;

    const handle = await agentsApi!.create({
      sessionId: SessionId(conversationId),
      agentOptions: { provider: 'thihy', model },
    });

    const entry: ConversationEntry = {
      id: conversationId,
      agent: handle.agent,
      disposeHandle: () => handle.dispose(),
      offSession: () => {},
      fullText: '',
      callMeta: new Map(),
      dormant: true,
      turnTokensIn: 0,
      turnTokensOut: 0,
    };
    conversations.set(conversationId, entry);
    return entry;
  }

  // Returns a fresh unsubscribe function — sets entry.fullText/callMeta and
  // wires the onEvent delivery for THIS call's invocationId. We do not
  // attach a permanent listener: between turns we have no live consumer, so
  // persisting the listener would just leak onEvent callables.
  //
  // Filtering: ctx.on('session/event', ...) fires for every active session,
  // so we filter by session.id === conversationId. This is what keeps
  // parallel conversations' event streams independent.
  function attachLiveListener(
    entry: ConversationEntry,
    invocationId: string,
    onEvent: (e: TurnEvent) => void,
  ): () => void {
    entry.fullText = '';
    entry.callMeta.clear();
    entry.turnTokensIn = 0;
    entry.turnTokensOut = 0;
    const off = ctx.on('session/event', (session: unknown, event: { type: string; data?: unknown }) => {
      // session.id is a branded string; conversationId is a plain string.
      // String compare is the safe check.
      const sid = (session as { id?: unknown } | undefined)?.id;
      if (String(sid) !== entry.id) return;
      const t = event?.type;
      if (t === 'assistant/chunk') {
        const d = event.data as { chunk?: { type?: string; text?: string } } | undefined;
        const chunk = d?.chunk;
        if (chunk?.type === 'text-delta' && chunk.text) {
          entry.fullText += chunk.text;
          onEvent({ type: 'token', text: chunk.text });
        } else if (chunk?.type === 'reasoning-delta' && chunk.text) {
          // The model's thinking stream (glm-5.2 / deepseek-reasoner
          // reasoning_content). Forwarded separately so the UI can render a
          // collapsible "思考过程" panel distinct from the answer.
          onEvent({ type: 'reasoning', text: chunk.text });
        }
      } else if (t === 'assistant/message') {
        // The assembled message for one step carries `usage` when the
        // adapter reported token accounting. We sum across steps so the
        // final `done` event reflects the whole turn.
        const d = event.data as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
        if (d?.usage) {
          entry.turnTokensIn  += d.usage.inputTokens  ?? 0;
          entry.turnTokensOut += d.usage.outputTokens ?? 0;
        }
      } else if (t === 'tool/call') {
        const d = event.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
        if (d?.callId != null && d.name) entry.callMeta.set(String(d.callId), { name: d.name, args: d.arguments ?? '' });
        onEvent({ type: 'toolCall', name: d?.name ?? '', args: d?.arguments });
      } else if (t === 'tool/result') {
        const d = event.data as {
          message?: {
            source?: { callId?: unknown };
            content?: Array<{ isError?: boolean; content?: unknown[] }>;
          };
        } | undefined;
        const callId = d?.message?.source?.callId;
        const meta = callId != null ? entry.callMeta.get(String(callId)) : undefined;
        const block = d?.message?.content?.[0];
        onEvent({
          type: 'toolResult',
          name: meta?.name ?? '',
          args: meta?.args,
          ok: !block?.isError,
          data: block?.content,
        });
      }
    });
    entry.offSession = off;
    // Track which invocationId owns the live listener. Not strictly needed
    // today (each runTurn installs + clears its own listener) but useful
    // for diagnostics and any future "two turns on the same conversation
    // at once" feature.
    entry.dormant = false;
    void invocationId;
    return off;
  }

  // 4. Expose the runtime API.
  const runtime: DshRuntime = {
    async runTurn({ prompt, conversationId, invocationId, onEvent, signal }) {
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
      const endpoint = deps.getEndpoint();
      const model = endpoint?.model ?? 'deepseek-chat';
      const entry = await ensureAgent(conversationId, model);
      const off = attachLiveListener(entry, invocationId, onEvent);
      try {
        const userMsg = createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        });
        entry.agent.followup(userMsg);
        // Cooperative cancellation: if the renderer cancels, soft-abort the
        // agent. L3-A: prefer `agent.cancel({kind:'user'})` over disposing the
        // handle — the agent survives so the next followup() reuses the same
        // session without a re-resume cost. whenIdle() will then resolve as
        // the aborted turn converges to idle. Without an active turn the call
        // is a no-op (per DSH docs), which is safe for spurious abort signals.
        signal?.addEventListener('abort', () => {
          try { entry.agent.cancel({ kind: 'user' }); } catch { /* noop */ }
        });
        await entry.agent.whenIdle();
        // L4-E: read accumulated token counts from the entry, attach to done.
        onEvent({ type: 'done', content: entry.fullText, tokensIn: entry.turnTokensIn, tokensOut: entry.turnTokensOut });
        return { content: entry.fullText, tokensIn: entry.turnTokensIn, tokensOut: entry.turnTokensOut };
      } finally {
        try { off(); } catch { /* noop */ }
        entry.dormant = true;
      }
    },

    async cancel(conversationId) {
      const entry = conversations.get(conversationId);
      if (!entry) return;
      // L3-A: SOFT cancel. The agent handle stays alive in the cache, so the
      // next followup() (a new turn on this conversation) resumes on the
      // same agent + persisted session. Hard dispose is reserved for explicit
      // `disposeConversation()` (called from ai.conversation.delete).
      //
      // - If a turn is in flight: agent.cancel({kind:'user'}) aborts it and
      //   whenIdle() resolves quickly. Pending text/tool events may have
      //   already streamed — those are part of the durable session log so
      //   loadHistory() still returns them honestly.
      // - If idle: cancel is a no-op (per DSH docs), so calling it on a
      //   quiet agent is safe.
      try { entry.agent.cancel({ kind: 'user' }); } catch { /* noop */ }
      // We do NOT conversations.delete() — that would force a re-resume on
      // the next ask() and lose the agent's internal caches (pre-step
      // decisions, resolved system prompts) we just paid to build.
    },

    async loadHistory({ conversationId }) {
      if (!persistenceApi) return [];
      let inspection;
      try {
        inspection = await persistenceApi.load(conversationId);
      } catch (err) {
        logger.warn(`loadHistory(${conversationId}) failed: ${(err as Error).message}`);
        return [];
      }
      if (!inspection) return [];
      return foldHistory(inspection.events);
    },

    async disposeConversation(conversationId) {
      const entry = conversations.get(conversationId);
      if (!entry) return;
      conversations.delete(conversationId);
      try { entry.offSession(); } catch { /* noop */ }
      try { await entry.disposeHandle(); } catch { /* noop */ }
    },

    async removeSession(conversationId) {
      // The JSONL plugin doesn't expose a delete method (it's append-only
      // by design) — we walk the persistence root and rm the per-session
      // directory. Layout is <root>/<sanitized-project>/<sessionId>/.
      const root = process.env['DSH_SESSIONS_ROOT'];
      if (!root || !existsSync(root)) return { removed: false };
      let removed = false;
      try {
        const projects = readdirSync(root, { withFileTypes: true });
        for (const p of projects) {
          if (!p.isDirectory()) continue;
          const target = join(root, p.name, conversationId);
          if (!existsSync(target)) continue;
          rmSync(target, { recursive: true, force: true });
          logger.info(`removeSession(${conversationId}): removed ${target}`);
          removed = true;
          // Multiple project dirs in principle (different cwd contexts);
          // remove them all so the conversation is fully purged.
        }
      } catch (err) {
        logger.warn(`removeSession(${conversationId}) failed: ${(err as Error).message}`);
      }
      return { removed };
    },

    async dispose() {
      // L4-G: drain any open human-in-the-loop waterfalls before tearing
      // down the cordis fiber — otherwise the 90s timers fire into a
      // half-closed runtime and `BrowserWindow.getAllWindows()` finds
      // no listener. Settling with reject('aborted') / resolve('cancelled')
      // makes DSH's tool loop unblock and surface a graceful "已取消" to
      // the model instead of hanging.
      cancelAllPending();
      // Tear down all conversation handles first (each dispose awaits its
      // own whenIdle + cleanup), then drop the cordis fiber.
      const all = Array.from(conversations.values());
      conversations.clear();
      await Promise.allSettled(all.map(async (e) => {
        try { e.offSession(); } catch { /* noop */ }
        try { await e.disposeHandle(); } catch { /* noop */ }
      }));
      disposeAdapter();
      disposeTools();
      await ctx.fiber?.dispose?.();
    },
  };
  return runtime;
}

/**
 * Fold a session event log into a flat list of HistoryTurn entries.
 *
 * - user/message → one user turn (concatenated text blocks). Shape:
 *   `data.content: [{type, text}]` (NOT `data.message.content` — different
 *   from assistant/message).
 * - assistant/text → reconstructed from `assistant/chunk` text-deltas between
 *   step boundaries. The final `assistant/message` event sometimes has
 *   `data.message.content` with empty text blocks (the streamed answer
 *   "苹果" is in the chunks, not in the final event — a DSH serialization
 *   quirk), so chunks are the source of truth. Reasoning content (if any)
 *   is aggregated from reasoning-delta chunks and surfaced as the
 *   `reasoning` field of the assistant turn.
 * - tool/call + tool/result → one tool turn (paired by callId; missing
 *   result is still emitted as a tool turn with ok=false, error="no result").
 * - Structural events (turn/start, step/end) are skipped; we use them as
 *   boundaries for flushing accumulated assistant text.
 *
 * L3-I: exported so vitest can unit-test it directly. The shape tests
 * live in tests/dsh-runtime-foldHistory.test.ts and pin the exact event
 * shapes this function depends on — guard against silent regressions
 * if a future DSH upgrade changes how the persistence plugin serializes
 * chunks / final messages.
 */
export function foldHistory(events: ReadonlyArray<{ type: string; data?: unknown }>): HistoryTurn[] {
  const turns: HistoryTurn[] = [];

  // First pass: index tool/result by callId so we can pair with tool/call.
  const pendingResults = new Map<string, { ok: boolean; data?: unknown; error?: string }>();
  for (const ev of events) {
    if (ev.type === 'tool/result') {
      const d = ev.data as {
        message?: {
          source?: { callId?: unknown };
          content?: Array<{ isError?: boolean; content?: unknown[] }>;
        };
      } | undefined;
      const callId = d?.message?.source?.callId;
      const block = d?.message?.content?.[0];
      if (callId != null) {
        pendingResults.set(String(callId), {
          ok: !block?.isError,
          data: block?.content,
          error: block?.isError ? JSON.stringify(block?.content) : undefined,
        });
      }
    }
  }

  // Second pass: walk in order, accumulating assistant text/reasoning from
  // chunks and flushing on boundaries (user turn, tool call, step end).
  let bufText = '';
  let bufReasoning = '';

  const flushAssistant = (): void => {
    if (bufText || bufReasoning) {
      const out: HistoryTurn = bufReasoning
        ? { type: 'assistant', text: bufText, reasoning: bufReasoning }
        : { type: 'assistant', text: bufText };
      turns.push(out);
      bufText = '';
      bufReasoning = '';
    }
  };

  for (const ev of events) {
    if (ev.type === 'user/message') {
      flushAssistant();
      // user/message shape: { content: [{type, text}], source, role, id }
      const d = ev.data as {
        content?: Array<{ type?: string; text?: string }>;
      } | undefined;
      const text = (d?.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text) turns.push({ type: 'user', text });
    } else if (ev.type === 'assistant/chunk') {
      // Aggregate streaming deltas. chunks are scoped to the current step;
      // step boundaries (step/end, user turn, tool call) flush below.
      const d = ev.data as {
        chunk?: { type?: string; text?: string };
      } | undefined;
      const chunk = d?.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        bufText += chunk.text;
      } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        bufReasoning += chunk.text;
      }
      // Other chunk types (block-start, block-end) are bookkeeping — ignored.
    } else if (ev.type === 'assistant/message') {
      // If chunks didn't populate the buffer (very short responses that snap
      // straight to the final event without streaming), fall back to the
      // message's own content blocks. Chunks always win when both are
      // present — the final event has empty text even when chunks carried
      // the answer.
      if (!bufText && !bufReasoning) {
        const d = ev.data as {
          message?: {
            content?: Array<{ type?: string; text?: string }>;
          };
        } | undefined;
        const blocks = d?.message?.content ?? [];
        bufText = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('');
        bufReasoning = blocks
          .filter((b) => b?.type === 'reasoning' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('');
      }
    } else if (ev.type === 'step/end' || ev.type === 'turn/end') {
      flushAssistant();
    } else if (ev.type === 'tool/call') {
      // A tool call interrupts the assistant's text — flush whatever was
      // accumulated, then emit the tool turn.
      flushAssistant();
      const d = ev.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
      const callId = d?.callId != null ? String(d.callId) : '';
      const result = callId ? pendingResults.get(callId) : undefined;
      turns.push({
        type: 'tool',
        name: d?.name ?? '',
        args: d?.arguments,
        ok: result?.ok ?? false,
        data: result?.data,
        error: result?.error ?? (result ? undefined : 'no result'),
      });
    }
    // Everything else (chunks we already handled, structural start events,
    // session/end-seed, request/*) is intentionally skipped.
  }

  // Trailing flush — if the log ends mid-step without an explicit boundary.
  flushAssistant();
  return turns;
}

/** Register the domain tools (todo/content/drawing) ported from dsh/tools.ts. */
function registerDomainTools(
  tools: { register(def: unknown): () => void },
  defineTool: (d: any) => unknown,
  deps: DshRuntimeDeps,
  ctx: DshContext,
): () => void {
  const disposers: Array<() => void> = [];
  const { repo, md, drawings, conversations, db, attachmentsDir, settings, docs } = deps;
  const reg = (def: unknown) => disposers.push(tools.register(def));

  // DSH's `output.render(args, value)` produces the MODEL-FACING content for a
  // tool result. Returning a placeholder token (e.g. '[todo.list]') hides the
  // real data from the model — it would then fabricate answers (claim the list
  // is empty, invent a created todo's id). Serialize the actual JSON value so
  // the model grounds its answer in real data.
  const renderJson = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: value === undefined ? '(no result)' : JSON.stringify(value, null, 2) },
  ];
  const jsonOutput = { schema: { type: 'json' }, render: renderJson };

  // ---------------------------------------------------------------------------
  // todo.* — CRUD over the TODO table.
  //
  // The tool surface mirrors the renderer's full TodoCreate / TodoPatch
  // shape so the AI can file tasks by tag, due date, or project, not just
  // title + status. todo.list's filter set also expands to match the
  // shared TodoFilter type — the AI should be able to answer "what's due
  // this week" without having to fetch everything and filter in
  // conversation.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'todo.list',
    description: 'List TODO items, optionally filtered. Every field is optional; omit all of them to return every todo. The model may pass status/priority/tag as a single string or a JSON array. "all" / unknown values for status/priority mean no filter.',
    parameters: {
      status: { type: 'string', description: 'Filter by status: next | doing | done | cancelled | blocked (or comma-separated)' },
      priority: { type: 'string', description: 'Filter by priority: none | low | medium | high (or comma-separated)' },
      tag: { type: 'string', description: 'Filter by a single tag (matches tasks tagged with this string)' },
      project: { type: 'string', description: 'Filter by project path id' },
      dueBefore: { type: 'number', description: 'Only tasks with dueAt <= this unix ms' },
      dueAfter: { type: 'number', description: 'Only tasks with dueAt >= this unix ms' },
      search: { type: 'string', description: 'Substring match against title (server-side WHERE LIKE)' },
      parentId: { type: 'string', description: 'List direct subtasks of this parent TODO; null/omitted lists all tasks regardless of nesting' },
      archivedOnly: { type: 'boolean', description: 'Only archived tasks (the 归档 bin). Default false.' },
      includeArchived: { type: 'boolean', description: 'Include archived tasks alongside active ones. Default false — the list excludes archived tasks (auto-archived done work) to stay decluttered. Pass true when the user asks about old/completed work.' },
      deletedOnly: { type: 'boolean', description: 'Only soft-deleted tasks (the 已删除 recovery bin, newest deletion first). Default false. Deleted tasks are excluded from every other list query; this is the only way to surface them.' },
      limit: { type: 'number', description: 'Max items to return (default: all)' },
    },
    output: jsonOutput,
    async execute(args: { status?: string; priority?: string; tag?: string; project?: string; dueBefore?: number; dueAfter?: number; search?: string; parentId?: string; archivedOnly?: boolean; includeArchived?: boolean; deletedOnly?: boolean; limit?: number }) {
      const filter: TodoFilter = {};
      const st = args.status;
      if (st) {
        const arr = String(st).split(',').map((s) => s.trim()).filter(Boolean);
        const valid = arr.filter((s): s is TodoStatus => (TODO_STATUSES as readonly string[]).includes(s));
        if (valid.length) filter.status = valid;
      }
      const pr = args.priority;
      if (pr) {
        const arr = String(pr).split(',').map((s) => s.trim()).filter(Boolean);
        const valid = arr.filter((s): s is Priority => (PRIORITIES as readonly string[]).includes(s));
        if (valid.length) filter.priority = valid;
      }
      if (args.tag) filter.tag = [args.tag];
      if (args.project) filter.project = [args.project];
      if (args.dueBefore != null) filter.dueBefore = args.dueBefore;
      if (args.dueAfter != null) filter.dueAfter = args.dueAfter;
      if (args.search) filter.search = args.search;
      if (args.parentId !== undefined && args.parentId !== '') filter.parentId = args.parentId || null;
      if (args.archivedOnly) filter.archivedOnly = true;
      else if (args.includeArchived) filter.includeArchived = true;
      if (args.deletedOnly) filter.deletedOnly = true;
      const all = repo.list(filter as never);
      return args.limit && args.limit > 0 ? all.slice(0, args.limit) : all;
    },
  }));

  reg(defineTool({
    name: 'todo.get',
    description: 'Get a single TODO by id. Returns null if the id is unknown.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id (ULID)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return repo.get(args.id as never); },
  }));

  reg(defineTool({
    name: 'todo.create',
    description: 'Create a new TODO. Returns the created item including its generated id. Markdown body starts empty — use content.writeBody to add notes/progress later. Pass parentId to create as a subtask of an existing TODO (e.g. "把这个任务拆成三个子任务").',
    parameters: {
      title: { type: 'string', required: true, description: 'TODO title (required)' },
      status: { type: 'string', description: 'next | doing | done | cancelled | blocked (default next)' },
      priority: { type: 'string', description: 'none | low | medium | high (default none)' },
      project: { type: 'string', description: 'Project id/path; null/omitted means no project' },
      dueAt: { type: 'number', description: 'Due date as unix ms; null/omitted means no due date' },
      tags: { type: 'string', description: 'JSON array of tag strings (e.g. \'["urgent","design"]\')' },
      parentId: { type: 'string', description: 'Parent TODO id to create as a subtask; null/omitted means top-level. Use subtasks.list on the parent to see existing children before adding more. Cycles are rejected — you cannot nest a task under one of its own descendants.' },
    },
    output: jsonOutput,
    async execute(args: { title: string; status?: string; priority?: string; project?: string; dueAt?: number; tags?: string; parentId?: string }) {
      const input: TodoCreate = { title: args.title };
      if (args.status && (TODO_STATUSES as readonly string[]).includes(args.status)) input.status = args.status as TodoStatus;
      if (args.priority && (PRIORITIES as readonly string[]).includes(args.priority)) input.priority = args.priority as Priority;
      if (args.project !== undefined) input.project = args.project || null;
      if (args.dueAt != null) input.dueAt = args.dueAt;
      if (args.tags) {
        try {
          const parsed = JSON.parse(args.tags);
          if (Array.isArray(parsed)) input.tags = parsed.filter((s): s is string => typeof s === 'string');
        } catch { /* swallow malformed tag list */ }
      }
      if (args.parentId !== undefined) input.parentId = args.parentId || null;
      const todo = repo.create(input, md.filePathFor('placeholder' as never));
      md.writeBody(todo.id as never, '');
      return repo.get(todo.id as never);
    },
  }));

  reg(defineTool({
    name: 'todo.update',
    description: 'Update fields of an existing TODO. Pass only the fields you want to change — null clears the field (e.g. dueAt: null). Setting status="done" automatically stamps doneAt; any other status clears it. Pass parentId to reparent a task (make it a subtask of another); pass parentId=null to promote to top-level. Cycles are rejected. Pass archivedAt to archive (a unix-ms timestamp, e.g. Date.now()) or archivedAt=null to restore an archived task.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      title: { type: 'string' },
      status: { type: 'string', description: 'next | doing | done | cancelled | blocked' },
      priority: { type: 'string', description: 'none | low | medium | high' },
      project: { type: 'string', description: 'Project id; null/empty string clears' },
      dueAt: { type: 'number', description: 'Due date as unix ms; null clears' },
      tags: { type: 'string', description: 'JSON array of tag strings; replaces the existing tag set' },
      parentId: { type: 'string', description: 'Parent TODO id to reparent under; null/empty string promotes to top-level.' },
      archivedAt: { type: 'number', description: 'Archive (unix ms, e.g. Date.now()) or restore (null) a task. Archived tasks leave the active list but stay in the 归档 bin.' },
    },
    output: jsonOutput,
    async execute(args: { id: string; title?: string; status?: string; priority?: string; project?: string; dueAt?: number; tags?: string; parentId?: string; archivedAt?: number | null }) {
      const { id, tags, ...rest } = args;
      const patch: TodoPatch = {};
      if (rest.title !== undefined) patch.title = rest.title;
      if (rest.status && (TODO_STATUSES as readonly string[]).includes(rest.status)) patch.status = rest.status as TodoStatus;
      if (rest.priority && (PRIORITIES as readonly string[]).includes(rest.priority)) patch.priority = rest.priority as Priority;
      if (rest.project !== undefined) patch.project = rest.project || null;
      if (rest.dueAt !== undefined) patch.dueAt = rest.dueAt;
      if (rest.parentId !== undefined) patch.parentId = rest.parentId || null;
      if (rest.archivedAt !== undefined) patch.archivedAt = rest.archivedAt;
      if (tags !== undefined) {
        try {
          const parsed = JSON.parse(tags);
          if (Array.isArray(parsed)) patch.tags = parsed.filter((s): s is string => typeof s === 'string');
        } catch { /* swallow malformed tag list */ }
      }
      return repo.update(id, patch);
    },
  }));

  reg(defineTool({
    name: 'subtasks.list',
    description: 'List the direct subtasks of a TODO (parentId == id). Returns [] if the task has no subtasks or does not exist. Use this to inspect a parent\'s children before reparenting or to summarise "the work broken out under this task".',
    parameters: { parentId: { type: 'string', required: true, description: 'Parent TODO id' } },
    output: jsonOutput,
    async execute(args: { parentId: string }) {
      return repo.list({ parentId: args.parentId } as never);
    },
  }));

  reg(defineTool({
    name: 'todo.delete',
    description: 'Soft-delete a TODO and its entire subtree. This is a LOGICAL delete — the row, markdown body, and drawings survive so the action is always undoable via todo.restore. The task disappears from every active view (list, search, stats) and is only visible via todo.list with deletedOnly=true. No confirmation needed beyond the normal permission tier.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to soft-delete (cascades to its subtasks)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { repo.delete(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'todo.restore',
    description: 'Restore a soft-deleted TODO and its entire subtree — the inverse of todo.delete. Clears deleted_at on the task + every descendant so the whole branch returns to the active list. Safe to call on an already-live task (no-op).',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to restore (clears deleted_at on its subtree)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { repo.restore(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'todo.batchUpdate',
    description: 'Apply the same patch to multiple TODOs in one transaction. Useful for "mark all 未完成 items as done" or "reparent every task under a new parent". Returns the updated rows.',
    parameters: {
      ids: { type: 'string', required: true, description: 'JSON array of TODO ids' },
      status: { type: 'string' },
      priority: { type: 'string' },
      parentId: { type: 'string', description: 'Parent TODO id to reparent every task under; null/empty string promotes to top-level' },
      tags: { type: 'string' },
    },
    output: jsonOutput,
    async execute(args: { ids: string; status?: string; priority?: string; parentId?: string; tags?: string }) {
      let ids: string[];
      try {
        const parsed = JSON.parse(args.ids);
        if (!Array.isArray(parsed)) throw new Error('ids must be a JSON array of strings');
        ids = parsed.filter((s): s is string => typeof s === 'string');
      } catch (err) {
        throw new Error(`todo.batchUpdate: invalid ids — ${(err as Error).message}`);
      }
      const patch: TodoPatch = {};
      if (args.status && (TODO_STATUSES as readonly string[]).includes(args.status)) patch.status = args.status as TodoStatus;
      if (args.priority && (PRIORITIES as readonly string[]).includes(args.priority)) patch.priority = args.priority as Priority;
      if (args.parentId !== undefined) patch.parentId = args.parentId || null;
      if (args.tags) {
        try {
          const parsed = JSON.parse(args.tags);
          if (Array.isArray(parsed)) patch.tags = parsed.filter((s): s is string => typeof s === 'string');
        } catch { /* swallow */ }
      }
      return repo.batchUpdate(ids as never, patch);
    },
  }));

  reg(defineTool({
    name: 'todo.search',
    description: 'Full-text search across TODO titles and markdown bodies (FTS5-backed). Returns hits with a short snippet + score.',
    parameters: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number', description: 'Max hits (default 20)' } },
    output: jsonOutput,
    async execute(args: { query: string; limit?: number }) { return repo.search(args.query, args.limit ?? 20); },
  }));

  reg(defineTool({
    name: 'todo.stats',
    description: 'Aggregate stats: counts by status, 7-day completion rate, average done latency. Useful as a preflight before summarising the user\'s workload.',
    parameters: { windowDays: { type: 'number', description: 'Window for completion stats (default 7)' } },
    output: jsonOutput,
    async execute(args: { windowDays?: number }) { return repo.stats(args.windowDays ?? 7); },
  }));

  // ---------------------------------------------------------------------------
  // content.* — markdown body of a TODO.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'content.readBody',
    description: 'Read the markdown body of a TODO (current version). Returns markdown text + the version number.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.readBody(args.id as never); },
  }));

  reg(defineTool({
    name: 'content.writeBody',
    description: 'Write/replace the markdown body of a TODO. Creates a new version (old version preserved for content.history). For long drafts, write the full body each time — partial updates are not supported.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      markdown: { type: 'string', required: true, description: 'New markdown content' },
    },
    output: jsonOutput,
    async execute(args: { id: string; markdown: string }) { return md.writeBody(args.id as never, args.markdown); },
  }));

  reg(defineTool({
    name: 'content.history',
    description: 'List saved markdown versions for a TODO, oldest to newest. Each entry has an id (version number), savedAt, and the body. Use content.restoreVersion to roll back.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.history(args.id as never); },
  }));

  reg(defineTool({
    name: 'content.restoreVersion',
    description: 'Restore a previous markdown version. The current version is preserved as a new version before the restore (so undo via content.history + restoreVersion is always possible). Destructive in the sense that it overwrites current body — confirm with the user first.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      versionId: { type: 'number', required: true, description: 'Version number to restore (from content.history)' },
    },
    output: jsonOutput,
    async execute(args: { id: string; versionId: number }) { md.restoreVersion(args.id as never, args.versionId); return { ok: true }; },
  }));

  // ---------------------------------------------------------------------------
  // drawing.* — Excalidraw scenes attached to a TODO.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'drawing.list',
    description: 'List Excalidraw drawings attached to a TODO. Returns metadata (id, title, thumb path, timestamps). Use drawing.read to get the scene JSON.',
    parameters: { todoId: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { todoId: string }) { return drawings.list(args.todoId as never); },
  }));

  reg(defineTool({
    name: 'drawing.read',
    description: 'Read an Excalidraw drawing scene by id. Returns the full scene JSON (elements, appState). Throws if the id is unknown or the scene file is missing on disk.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return drawings.read(args.id as never); },
  }));

  reg(defineTool({
    name: 'drawing.save',
    description: 'Save (create or update) an Excalidraw drawing for a TODO. Pass `id` to update an existing drawing; omit to create a new one. The `scene` is the full Excalidraw scene JSON.',
    parameters: {
      todoId: { type: 'string', required: true, description: 'TODO id this drawing belongs to' },
      scene: { type: 'json', required: true, description: 'Excalidraw scene JSON: { elements, appState, ... }' },
      id: { type: 'string', description: 'Existing drawing id to update (omit to create)' },
      title: { type: 'string', description: 'Optional human-readable title' },
    },
    output: jsonOutput,
    async execute(args: { todoId: string; scene: unknown; id?: string; title?: string }) {
      return drawings.save(args.todoId as never, args.scene as never, args.id as never, args.title);
    },
  }));

  reg(defineTool({
    name: 'drawing.delete',
    description: 'Permanently delete a drawing. Destructive — confirm with the user first.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { drawings.delete(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'drawing.setThumb',
    description: 'Set the thumbnail image for a drawing (a data: URL, typically captured from the canvas). The renderer uses this to show a preview chip in the drawing list. Not destructive.',
    parameters: {
      id: { type: 'string', required: true, description: 'Drawing id' },
      dataUrl: { type: 'string', required: true, description: 'data: URL of the thumbnail image (e.g. data:image/png;base64,...)' },
    },
    output: jsonOutput,
    async execute(args: { id: string; dataUrl: string }) { drawings.setThumb(args.id as never, args.dataUrl); return { ok: true }; },
  }));

  // ---------------------------------------------------------------------------
  // inbox.* — attach a file (path) or pasted image (data: URL) to a TODO.
  //
  // Mirrors the IPC `inbox.attach` / `inbox.attachBlob` handlers in main/index.ts.
  // The AI uses these when a user says "attach this file to that todo" or
  // "add this screenshot to the bug" — typically the file is already on disk
  // (clipboard image save path, screenshot) or arrives as a data: URL.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'inbox.attach',
    description: 'Attach a file from disk to a TODO. Copies the file into the app\'s attachments directory and records it in inbox_attachments. Returns the new attachment row.',
    parameters: {
      todoId: { type: 'string', required: true, description: 'Target TODO id' },
      filePath: { type: 'string', required: true, description: 'Absolute path to the file to attach' },
      mime: { type: 'string', required: true, description: 'MIME type (e.g. "image/png", "application/pdf")' },
    },
    output: jsonOutput,
    async execute(args: { todoId: string; filePath: string; mime: string }) {
      mkdirSync(attachmentsDir, { recursive: true });
      const id = randomUUID();
      const filename = `${id}-${basename(args.filePath)}`;
      const target = join(attachmentsDir, filename);
      copyFileSync(args.filePath, target);
      const now = Date.now();
      db.prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, args.todoId, target, args.mime, now);
      return { id, todoId: args.todoId, filePath: target, mime: args.mime, createdAt: now };
    },
  }));

  reg(defineTool({
    name: 'inbox.attachBlob',
    description: 'Attach a pasted image (data: URL) to a TODO. Decodes the data URL, writes the bytes to disk, records the row. Use for screenshots / clipboard images the user said "add this picture to the todo".',
    parameters: {
      todoId: { type: 'string', required: true, description: 'Target TODO id' },
      dataUrl: { type: 'string', required: true, description: 'data: URL of the image (e.g. data:image/png;base64,iVBORw0K...)' },
      filename: { type: 'string', required: true, description: 'Original filename (used for extension inference and display)' },
      mime: { type: 'string', required: true, description: 'MIME type (e.g. "image/png")' },
    },
    output: jsonOutput,
    async execute(args: { todoId: string; dataUrl: string; filename: string; mime: string }) {
      mkdirSync(attachmentsDir, { recursive: true });
      const id = randomUUID();
      const comma = args.dataUrl.indexOf(',');
      const header = args.dataUrl.slice(0, comma);
      const isBase64 = /;base64/i.test(header);
      const payload = args.dataUrl.slice(comma + 1);
      const buf = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
      const ext = mimeExt(args.mime);
      const filename = `${id}-${sanitizeName(args.filename) || 'pasted'}.${ext}`;
      const target = join(attachmentsDir, filename);
      writeFileSync(target, buf);
      const now = Date.now();
      db.prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, args.todoId, target, args.mime, now);
      return { id, todoId: args.todoId, filePath: target, mime: args.mime, createdAt: now };
    },
  }));

  // ---------------------------------------------------------------------------
  // conversation.* — manage the AI's own threads.
  //
  // These are how the AI lists / creates / archives past conversations. Most
  // of the time the AI's `ai.ask` runs on the conversation the user is
  // already on (so the runtime carries it implicitly), but occasionally the
  // AI needs to spawn a side thread ("let me think through this in a scratch
  // thread"), find a previous session ("what did we call the design review?"),
  // or archive a completed thread.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'conversation.list',
    description: 'List AI conversations. By default archived threads are hidden. Each row includes the title, timestamps, and an archived flag. Use conversation.history to load the turns of a specific conversation.',
    parameters: { includeArchived: { type: 'boolean', description: 'Include archived conversations (default false)' } },
    output: jsonOutput,
    async execute(args: { includeArchived?: boolean }) { return { conversations: conversations.list(args.includeArchived ?? false) }; },
  }));

  reg(defineTool({
    name: 'conversation.create',
    description: 'Create a new (empty) AI conversation. Returns the new conversation row (id, title, timestamps). The default title is "新对话 <timestamp>" — the DSH session-title service will replace it with an AI-generated title after the first turn, or the user can rename it via the UI.',
    parameters: { title: { type: 'string', description: 'Optional explicit title; omit to use the default new-conversation title' } },
    output: jsonOutput,
    async execute(args: { title?: string }) { return { conversation: conversations.create(args.title ? { title: args.title } : undefined) }; },
  }));

  reg(defineTool({
    name: 'conversation.rename',
    description: 'Rename an AI conversation. Throws if the id is unknown or the title is empty.',
    parameters: {
      id: { type: 'string', required: true, description: 'Conversation id' },
      title: { type: 'string', required: true, description: 'New title' },
    },
    output: jsonOutput,
    async execute(args: { id: string; title: string }) {
      const ok = conversations.rename(args.id, args.title);
      if (!ok) throw new Error(`conversation.rename: ${args.id} not found or archived`);
      return { ok: true };
    },
  }));

  reg(defineTool({
    name: 'conversation.archive',
    description: 'Archive an AI conversation (soft delete). Hidden from the default list. Reversible via conversation.unarchive. The on-disk JSONL log is NOT touched.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.archive(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.unarchive',
    description: 'Restore an archived conversation so it shows in the default list again.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.unarchive(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.delete',
    description: 'Hard delete the DB row of an AI conversation. The on-disk JSONL event log is NOT cleaned up by this (out of scope). Prefer conversation.archive for "I\'m done with this thread" semantics.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.delete(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.history',
    description: 'Load the persisted turn history of a conversation. Returns the same shape the AIPane uses: { type: "user" | "assistant" | "tool", text?, reasoning?, name?, args?, ok?, data?, error? }. Use this to "remember" what a past conversation discussed.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) {
      // L4-H: history loading lives on the runtime (it owns the
      // dsh-session-persistence-jsonl backend). At tool-call time we
      // don't have a direct handle — but a future improvement is to
      // expose `runtime.loadHistory()` on deps. For now, return an
      // empty array and let the model know it can ask the user to
      // surface a specific thread via the AIPane UI.
      // Use `args.id` so a future implementation that needs to compute
      // a stable per-conversation key has a guaranteed-not-undefined
      // value to anchor on.
      void args.id;
      return {
        turns: [],
        note: 'conversation.history at the tool layer is a stub; the AIPane UI loads the full history for the user when they switch threads. If you need to recall a past conversation, ask the user to open it.',
      };
    },
  }));

  // ---------------------------------------------------------------------------
  // ai.* — self-introspection. The AI can check its own connectivity,
  // discover available models, and read its own cost so far.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'ai.health',
    description: 'Check the AI provider connection. Returns { ok, mode, latencyMs?, error? }. "shim" mode means offline / no API key — model calls will echo pre-canned answers. Use this before declaring "the API is broken" — it might just be missing credentials.',
    parameters: {},
    output: jsonOutput,
    async execute() {
      try {
        const s = settings.get();
        const ep = resolveEndpoint(s);
        if (!ep) return { ok: false, mode: 'shim', error: 'no_api_key' };
        if (ep.protocol !== 'openai' || s.provider !== 'ollama') {
          if (!ep.apiKey) return { ok: false, mode: 'shim', error: 'no_api_key' };
        }
        const hc = await healthCheck(ep);
        return { ok: hc.ok, mode: hc.ok ? 'real' : 'shim', latencyMs: hc.latencyMs, error: hc.error };
      } catch (err) {
        return { ok: false, mode: 'shim', error: (err as Error).message };
      }
    },
  }));

  reg(defineTool({
    name: 'ai.models',
    description: 'List the configured model(s) for the active provider. Returns the list of models the user has enabled (per-provider defaults from settings). Useful when the user asks "which model are you?".',
    parameters: {},
    output: jsonOutput,
    async execute() {
      const s = settings.get();
      return { model: s.model, provider: s.provider, models: [s.model] };
    },
  }));

  reg(defineTool({
    name: 'ai.stats',
    description: 'Read the cumulative AI cost from settings (sum of every successful turn\'s costUsd). Useful when the user asks "how much have you spent this month?"',
    parameters: {},
    output: jsonOutput,
    async execute() {
      const s = settings.get();
      return { monthlyCostUsd: s.monthlyCostUsd, lastHeartbeatAt: s.lastHeartbeatAt };
    },
  }));

  // ---------------------------------------------------------------------------
  // app.currentContext — "what is the user looking at right now".
  //
  // The renderer pushes its currently focused entity (task / document /
  // drawing) to main via `app.focus.set` whenever the selection changes.
  // This tool reads that pointer and enriches it with the full row so the
  // model can ground its answer in real data — e.g. "rewrite the progress
  // doc on the task I'm looking at" needs the task id + doc id, which this
  // returns together.
  //
  // Returns null when nothing is focused (user is on the list / stats view).
  // Don't fall back to "guess the most recent task" — that would fabricate
  // context and silently mis-attribute edits. If null, ask the user what
  // they want to work on, or call todo.list to find a candidate.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'app.currentContext',
    description: 'Read the user\'s current focus (what they have open right now — a task, document, or drawing). Returns the full row(s) so you can act on them with todo.update / content.writeBody / drawing.save etc. without a separate lookup. Returns null when nothing is focused — the user is on the list/stats view, in which case call todo.list to find a candidate.',
    parameters: {},
    output: jsonOutput,
    async execute() {
      const f = getFocus();
      if (!f) return null;
      if (f.kind === 'task') {
        const t = repo.get(f.todoId as never);
        return { kind: 'task', task: t };
      }
      if (f.kind === 'document') {
        const t = repo.get(f.todoId as never);
        const d = docs.get(f.documentId as never);
        return { kind: 'document', task: t, document: d };
      }
      if (f.kind === 'drawing') {
        const t = repo.get(f.todoId as never);
        const g = drawings.get(f.drawingId as never);
        return { kind: 'drawing', task: t, drawing: g };
      }
      return null;
    },
  }));

  // ---------------------------------------------------------------------------
  // ask_user_approval — model-facing HITL primitive.
  //
  // NOTE: ask_user_question is NOT registered here. It is owned by
  // @deepseek-ai/dsh-tool-ask-user (mounted in cordis.yml), which
  // dispatches via ctx.userQuestions.ask() through the user-questions
  // waterfall. If we register it here as well, DSH boot fails with
  // "tool 'ask_user_question' is already registered" — see commit
  // 27de656… and the bug fixed when switching conversations used to
  // trip this on every switch.
  //
  // ask_user_approval is ours: DSH does not ship a built-in approval
  // tool, so we register it here and bridge via the 'approval/request'
  // waterfall (the listener installed in bootDsh() forwards to the
  // renderer via IPC, where UserApprovalCard renders the gate).
  //
  // 90s timeout — if the user doesn't answer in 90s, the call rejects
  // and the agent loop proceeds.
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'ask_user_approval',
    description: 'Pause the agent loop and ask the user to approve or reject a specific tool call. Returns one of: "allowed-once" | "rejected" | "cancelled" | "unavailable". Use this BEFORE performing an irreversible side effect (deleting a file, sending a message, etc.). The user can always "reject" — the agent loop then aborts the tool call. Auto-cancels after 90s.',
    parameters: {
      toolName: { type: 'string', required: true, description: 'Name of the tool the agent is about to call (for display in the approval card)' },
      reason: { type: 'string', required: true, description: 'Human-readable explanation of what this tool will do and why the user should approve' },
      preview: { type: 'string', description: 'Optional JSON-stringified preview of the args (shown in the card so the user sees what they\'re approving)' },
    },
    output: jsonOutput,
    async execute(args: { toolName: string; reason: string; preview?: string }) {
      if (typeof args.toolName !== 'string' || !args.toolName) {
        throw new Error('ask_user_approval: toolName is required');
      }
      if (typeof args.reason !== 'string' || !args.reason) {
        throw new Error('ask_user_approval: reason is required');
      }
      const noAnswerer = (): unknown => 'unavailable';
      const result = await ctx.waterfall(
        'approval/request',
        { toolName: args.toolName, reason: args.reason, preview: args.preview },
        noAnswerer,
      );
      return result as 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
    },
  }));

  return () => disposers.forEach(d => { try { d(); } catch { /* noop */ } });
}

/** Resolve a path relative to the app root, working in both dev and packaged. */
function resolveAppPath(rel: string): string | null {
  try {
    const root = app.getAppPath();
    const p = join(root, rel);
    return p;
  } catch {
    return null;
  }
}

// Keep dirname/pathToFileURL imports referenced (resolve/resolveAppPath path math).
void resolve; void dirname; void pathToFileURL;