// DSH runtime — boots the in-process agent tree, registers our ThihyLlmAdapter
// (wrapping client.ts invokeChat) for the 'thihy' provider route, registers
// our typed todo/content/drawing tool handlers, and exposes runTurn() to drive
// an agent turn and stream tokens + tool activity back to the renderer.
//
// This is the production counterpart of the proven spike at
// spikes/dsh-fulltree/boot-mock.ts. The runtime is additive: ai-handlers falls
// back to the text-only client.ts invokeChat path when boot fails or DSH is
// disabled, so the app keeps working even if the RC agent tree breaks.
//
// Packaging: the cordis.yml lives at resources/dsh/cordis.yml and the DSH
// ESM packages load from node_modules via bareModuleBaseUrl anchored to the
// app root. In a packaged asar the node_modules must be unpacked for the
// dynamic Loader resolution to find them (electron-builder asarUnpack).

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

export type TurnEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; name: string; args: unknown }
  | { type: 'toolResult'; name: string; args?: unknown; ok: boolean; data?: unknown; error?: string }
  | { type: 'done'; content: string }
  | { type: 'error'; message: string };

export interface DshRuntime {
  runTurn(opts: { prompt: string; invocationId: string; onEvent: (e: TurnEvent) => void; signal?: AbortSignal }): Promise<{ content: string }>;
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

  // 3. Expose runTurn.
  const runtime: DshRuntime = {
    async runTurn({ prompt, invocationId, onEvent, signal }) {
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
      const { SessionId } = await import('@deepseek-ai/dsh-session');
      const agents = ctx.get('agents') as {
        create(o: unknown): Promise<{
          agent: {
            followup(m: unknown): void;
            whenIdle(): Promise<void>;
            id: unknown;
          };
          dispose(): Promise<void>;
        }>;
      } | undefined;
      if (!agents) throw new Error('ctx.agents absent');

      const endpoint = deps.getEndpoint();
      const model = endpoint?.model ?? 'deepseek-chat';
      const handle = await agents.create({
        sessionId: SessionId(invocationId),
        agentOptions: { provider: 'thihy', model },
      });

      let fullText = '';
      // Stream durable session events to the renderer. assistant/chunk text
      // deltas are the live token stream; tool/call + tool/result are the
      // agent's tool activity.
      //
      // DSH session/event signature is (session, event): the 2nd arg carries
      // .type and .data. tool/result carries no tool name — only callId — so we
      // remember callId→{name, arguments} from the tool/call events to label
      // results and forward the args the model produced.
      const callMeta = new Map<string, { name: string; args: string }>();
      const off = ctx.on('session/event', (_session: unknown, event: { type: string; data?: unknown }) => {
        const t = event?.type;
        if (t === 'assistant/chunk') {
          // data: { turn, step, chunk: StreamChunk }
          const d = event.data as { chunk?: { type?: string; text?: string } } | undefined;
          const chunk = d?.chunk;
          if (chunk?.type === 'text-delta' && chunk.text) {
            fullText += chunk.text;
            onEvent({ type: 'token', text: chunk.text });
          } else if (chunk?.type === 'reasoning-delta' && chunk.text) {
            // The model's thinking stream (glm-5.2 / deepseek-reasoner
            // reasoning_content). Forwarded separately so the UI can render a
            // collapsible "思考过程" panel distinct from the answer.
            onEvent({ type: 'reasoning', text: chunk.text });
          }
        } else if (t === 'tool/call') {
          // data: { turn, step, callId, name, arguments(raw JSON string) }
          const d = event.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
          if (d?.callId != null && d.name) callMeta.set(String(d.callId), { name: d.name, args: d.arguments ?? '' });
          onEvent({ type: 'toolCall', name: d?.name ?? '', args: d?.arguments });
        } else if (t === 'tool/result') {
          // data: { turn, step, message: ToolResultMessage, error?, meta? }
          // ToolResultMessage.source.callId pairs with tool/call; the result
          // block (message.content[0]) carries isError + the value content.
          const d = event.data as {
            message?: {
              source?: { callId?: unknown };
              content?: Array<{ isError?: boolean; content?: unknown[] }>;
            };
          } | undefined;
          const callId = d?.message?.source?.callId;
          const meta = callId != null ? callMeta.get(String(callId)) : undefined;
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

      try {
        const userMsg = createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        });
        handle.agent.followup(userMsg);
        // Cooperative cancellation: if the renderer cancels, abort the agent.
        signal?.addEventListener('abort', () => {
          // agent.cancel requires the Agent handle; we only have followup/whenIdle
          // via the narrow type. Disposing the handle stops the driver.
          void handle.dispose();
        });
        await handle.agent.whenIdle();
        onEvent({ type: 'done', content: fullText });
        return { content: fullText };
      } finally {
        try { off(); } catch { /* noop */ }
        try { await handle.dispose(); } catch { /* noop */ }
      }
    },
    async dispose() {
      disposeAdapter();
      disposeTools();
      await ctx.fiber?.dispose?.();
    },
  };
  return runtime;
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
