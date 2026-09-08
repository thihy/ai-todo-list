// DSH runtime — boots the in-process agent tree, registers our ThihyLlmAdapter
// (wrapping client.ts invokeChat) for the 'thihy' provider route, registers
// our typed todo/content/drawing tool handlers, and exposes runTurn() to drive
// an agent turn and stream tokens + tool activity back to the renderer.
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

import { app } from 'electron';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { logger } from '../logger';
import type { ResolvedEndpoint } from './client';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { TodoFilter, TodoStatus } from '../../shared/todo-types';
import { TODO_STATUSES } from '../../shared/todo-types';

// DSH is imported dynamically so the main bundle stays buildable even before
// the packages are installed, and so a boot failure degrades to the client.ts
// path instead of crashing the app on import.
type DshContext = {
  get(key: string): unknown;
  on(event: string, handler: (...args: any[]) => void): () => void;
  fiber?: { dispose?(): Promise<void> };
};

export interface DshRuntimeDeps {
  getEndpoint: () => ResolvedEndpoint | null;
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
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
  | { type: 'done'; content: string }
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
  dispose(): Promise<void>;
}

let runtimePromise: Promise<DshRuntime | null> | null = null;

/** Lazily boot DSH once; returns null if boot fails (caller falls back to client.ts). */
export function getDshRuntime(deps: DshRuntimeDeps): Promise<DshRuntime | null> {
  if (!runtimePromise) {
    runtimePromise = bootDsh(deps).catch((err) => {
      logger.warn(`DSH boot failed, falling back to client.ts: ${(err as Error).message}`);
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
  const ctx: DshContext = await boot('thihy', cfg, undefined, undefined, bareBase);

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
  const disposeTools = registerDomainTools(tools, defineTool, deps);

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
        onEvent({ type: 'done', content: entry.fullText });
        return { content: entry.fullText };
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

    async dispose() {
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
 */
function foldHistory(events: ReadonlyArray<{ type: string; data?: unknown }>): HistoryTurn[] {
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
): () => void {
  const disposers: Array<() => void> = [];
  const { repo, md, drawings } = deps;
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

  reg(defineTool({
    name: 'todo.list',
    description: 'List TODO items, optionally filtered. Omit all filters to return every todo. The model may pass status as a single string or comma-separated list; "all" means no filter.',
    parameters: {
      status: { type: 'string', description: 'Filter by status: inbox | next | doing | blocked | done | all' },
      project: { type: 'string', description: 'Filter by project path id' },
      limit: { type: 'number', description: 'Max items to return (default: all)' },
    },
    output: jsonOutput,
    async execute(args: { status?: string; project?: string; limit?: number }) {
      // Normalize the model's status (string / comma-list / "all") into the
      // TodoStatus[] the repo expects; 'all' and unknown values mean no filter
      // so a full list is returned instead of erroring on `.map`.
      const filter: TodoFilter = {};
      const st = args.status;
      if (st) {
        const arr = String(st).split(',').map((s) => s.trim()).filter(Boolean);
        const valid = arr.filter((s): s is TodoStatus => (TODO_STATUSES as readonly string[]).includes(s));
        if (valid.length) filter.status = valid;
      }
      if (args.project) filter.project = [args.project];
      const all = repo.list(filter as never);
      return args.limit && args.limit > 0 ? all.slice(0, args.limit) : all;
    },
  }));
  reg(defineTool({
    name: 'todo.get',
    description: 'Get a single TODO by id.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id (ULID)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return repo.get(args.id as never); },
  }));
  reg(defineTool({
    name: 'todo.create',
    description: 'Create a new TODO with a title. Returns the created item.',
    parameters: { title: { type: 'string', required: true, description: 'TODO title' }, priority: { type: 'string', description: 'none | low | medium | high' } },
    output: jsonOutput,
    async execute(args: { title: string; priority?: string }) {
      const todo = repo.create({ title: args.title, priority: args.priority ?? 'none' } as never, md.filePathFor('placeholder' as never));
      md.writeBody(todo.id as never, '');
      return repo.get(todo.id as never);
    },
  }));
  reg(defineTool({
    name: 'todo.update',
    description: 'Update fields of an existing TODO (title, status, priority, dueAt, project).',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' }, title: { type: 'string' }, status: { type: 'string', description: 'inbox | next | doing | blocked | done' }, priority: { type: 'string', description: 'none | low | medium | high' } },
    output: jsonOutput,
    async execute(args: { id: string; [k: string]: unknown }) {
      const { id, ...patch } = args;
      return repo.update(id as never, patch as never);
    },
  }));
  reg(defineTool({
    name: 'todo.delete',
    description: 'Permanently delete a TODO. Destructive — confirm with the user first.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to delete' } },
    output: jsonOutput,
    async execute(args: { id: string }) { repo.delete(args.id as never); return { ok: true }; },
  }));
  reg(defineTool({
    name: 'todo.search',
    description: 'Full-text search across TODO titles and markdown bodies.',
    parameters: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number', description: 'Max hits (default 20)' } },
    output: jsonOutput,
    async execute(args: { query: string; limit?: number }) { return repo.search(args.query, args.limit ?? 20); },
  }));
  reg(defineTool({
    name: 'todo.stats',
    description: 'Aggregate stats: counts by status, recent activity.',
    parameters: {},
    output: jsonOutput,
    async execute() { return repo.stats(7); },
  }));

  reg(defineTool({
    name: 'content.readBody',
    description: 'Read the markdown body of a TODO (current version).',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.readBody(args.id as never); },
  }));
  reg(defineTool({
    name: 'content.writeBody',
    description: 'Write/replace the markdown body of a TODO. Creates a new version.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' }, markdown: { type: 'string', required: true, description: 'New markdown content' } },
    output: jsonOutput,
    async execute(args: { id: string; markdown: string }) { return md.writeBody(args.id as never, args.markdown); },
  }));
  reg(defineTool({
    name: 'content.history',
    description: 'List saved markdown versions for a TODO.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.history(args.id as never); },
  }));
  reg(defineTool({
    name: 'content.restoreVersion',
    description: 'Restore a previous markdown version. Destructive — confirm first.',
    parameters: { id: { type: 'string', required: true }, versionId: { type: 'number', required: true, description: 'Version number to restore' } },
    output: jsonOutput,
    async execute(args: { id: string; versionId: number }) { md.restoreVersion(args.id as never, args.versionId); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'drawing.list',
    description: 'List Excalidraw drawings attached to a TODO.',
    parameters: { todoId: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { todoId: string }) { return drawings.list(args.todoId as never); },
  }));
  reg(defineTool({
    name: 'drawing.read',
    description: 'Read an Excalidraw drawing scene by id.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return drawings.read(args.id as never); },
  }));
  reg(defineTool({
    name: 'drawing.save',
    description: 'Save (create or update) an Excalidraw drawing for a TODO.',
    parameters: { todoId: { type: 'string', required: true }, scene: { type: 'json', required: true, description: 'Excalidraw scene JSON' }, id: { type: 'string', description: 'Existing drawing id to update' }, title: { type: 'string' } },
    output: jsonOutput,
    async execute(args: { todoId: string; scene: unknown; id?: string; title?: string }) {
      return drawings.save(args.todoId as never, args.scene as never, args.id as never, args.title);
    },
  }));
  reg(defineTool({
    name: 'drawing.delete',
    description: 'Permanently delete a drawing. Destructive — confirm first.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { drawings.delete(args.id as never); return { ok: true }; },
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