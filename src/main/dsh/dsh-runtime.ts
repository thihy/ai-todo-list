// DSH runtime —— 启动进程内 agent 树，注册 TodoListLlmAdapter 到 'todo-list'
// 路由，注册 todo/content/drawing 工具，暴露 runTurn() 驱动一轮对话并流式
// 把 token 和工具事件回传给渲染端。
//
// 多会话模型 (L2)：每条会话 1:1 对应一个 DSH session（由
// dsh-session-persistence-jsonl 持久化）和一个缓存的 agent handle。会话间
// 互不干扰，agent handle 跨多轮复用（不每轮重建）。因此渲染端具备三个
// 原单 agent 设计做不到的能力：切会话不丢历史；同一时刻在不同会话上
// 并发提交；删除会话能干净销毁 agent，无僵尸 handle。
//
// 事件路由：ctx.on('session/event', ...) 全局触发，每个缓存的 agent 监听器
// 按 session.id 过滤后只转发本会话的事件，见 ensureAgent()。

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
import { presentToolCall, presentToolResult, recoverToolResultValue } from '@shared/tool-presentation';
import type Database from 'better-sqlite3';
import { mimeExt, sanitizeName } from '../util/mime';
import { decodeUserMessage, encodeTaskCreationEnvelope, type UserIntent } from '../../shared/task-creation';

// DSH 走动态 import：这样即使依赖没装，主 bundle 也能编译；同时启动失败时
// 渲染端能看到显式的 "DSH unavailable" 而不是 import 阶段崩掉。
type DshContext = {
  get(key: string): unknown;
  on(event: string, handler: (...args: any[]) => void): () => void;
  fiber?: { dispose?(): Promise<void> };
  /** L4-G: cordis waterfall 调用。ask_user_question / ask_user_approval 工具
   *  通过它复用 bootDsh() 里装好的同一条监听链，跨面板行为一致。监听器的
   *  promise 直接作为返回值（传一个返回 noAnswerer 的 next 标记这是直调
   *  而非嵌套）。 */
  waterfall(event: string, ...args: unknown[]): Promise<unknown>;
};

export interface DshRuntimeDeps {
  getEndpoint: () => ResolvedEndpoint | null;
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  /** DocumentStore —— 给 `app.currentContext` 工具补齐 document 类焦点
   *  对应的 task_documents 完整行 */
  docs: DocumentStore;
  /** 让 DSH session-title 服务能把 AI 生成的反向标题写回渲染端的会话列表 */
  conversations: ConversationRepo;
  /** inbox_attachments 写库用的原始 better-sqlite3 handle。inbox schema 很窄，
   *  不值得为此单独再开一个 repo 类型 */
  db: Database.Database;
  /** 附件 / 粘贴图片落盘的目录，首次使用自动 mkdir -p */
  attachmentsDir: string;
  /** Settings store —— ai.health / ai.models 工具要看 provider/model/连接态 */
  settings: SettingsStore;
}

// 一条渲染用的历史条目。从 JSONL 后端 loadHistory() 加载，也由 runTurn 的
// onEvent 实时产生。形状与 AIPane 已有的渲染一致：turn 文本 + 工具 call/result
// chip + 可选 reasoning 块，让 "实时轮次" 和 "历史轮次" 走同一渲染路径。
export type HistoryTurn =
  | { type: 'user'; text: string; intent?: UserIntent }
  | { type: 'assistant'; text: string; reasoning?: string }
  | {
      type: 'tool';
      /** Wire callId from tool/call (or synthesised orphan-N when only a
       *  tool/result was on the wire). Stable React key for the renderer. */
      callId: string;
      name: string;
      /** Raw args JSON string from tool/call. Passed through verbatim so the
       *  renderer can round-trip it through `parseToolArgs`. */
      args?: unknown;
      ok: boolean;
      data?: unknown;
      presentationMeta?: unknown;
      error?: string;
      /** Explicit lifecycle. The renderer mirrors this from projectStreamTurn;
       *  a `missing-result` turn is NOT an automatic failure — only `error` /
       *  `stopped` indicate execution went wrong. */
      state: 'done' | 'error' | 'stopped' | 'missing-call' | 'missing-result';
      /** False only for orphan tool/result turns (no matching tool/call in
       *  the log). Distinguishes "args = {}" from "未记录输入" downstream. */
      argsKnown: boolean;
    };

/** DSH 原始 session/event 形状（cordis 推过来的事件载荷）。
 *  监听器不再二次合成本地表状 TurnEvent——把这条流原样给上层，
 *  让 ai.ask 这种关心流语义的层去做 token/tool 翻译。 */
export type DshRawEvent = { type: string; data?: unknown };

/** LLM adapter 的 `StreamChunk` 最小形状（@deepseek-ai/dsh-llm 的流块）。
 *  只取我们桥接用到的两个 delta 形态；其余（block-start/end、usage、finish
 *  …）原样透传，不在此类型里展开。 */
type StreamChunkLike =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: string; [k: string]: unknown };

/** Mirror LLM deltas onto the session-shaped event surface while preserving
 * the original async iterable for DSH's BlockAssembler. Kept as a small pure
 * adapter so the streaming contract can be tested without booting Electron or
 * making a provider request. */
export async function* bridgeLlmStream(
  upstream: AsyncIterable<StreamChunkLike>,
  onEvent: (event: DshRawEvent) => void,
): AsyncIterable<StreamChunkLike> {
  for await (const chunk of upstream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      onEvent({ type: 'assistant/chunk', data: { chunk } });
    }
    yield chunk;
  }
}

export interface DshRuntime {
  runTurn(opts: {
    prompt: string;
    conversationId: string;
    invocationId: string;
    /** Explicit user intent for this turn. When `create-task`, main has
     *  already wrapped `prompt` into the create-task envelope, and the
     *  envelope is what the model sees. Absent on chat turns. */
    intent?: UserIntent;
    onEvent: (e: DshRawEvent) => void;
    signal?: AbortSignal;
  }): Promise<{ content: string; tokensIn: number; tokensOut: number }>;
  /** 中断当前会话正在跑的轮次（闲置/不存在则 no-op）。L3-A 的软取消：
   *  agent handle 不销毁，下一次 runTurn() 复用同一个 agent + 持久化的
   *  session JSONL，不必重新 resume。硬删除请用 disposeConversation()。 */
  cancel(conversationId: string): Promise<void>;
  loadHistory(opts: { conversationId: string; signal?: AbortSignal }): Promise<HistoryTurn[]>;
  /** 丢掉某条会话缓存的 agent（不在缓存里则 no-op） */
  disposeConversation(conversationId: string): Promise<void>;
  /** L3-G：删除某条会话在磁盘上的 JSONL 日志（不存在则 no-op）。
   *  递归删除 <DSH_SESSIONS_ROOT>/<project>/<id>/。DB 行由 ConversationRepo
   *  负责，本函数只管日志。对未知 id 安全，返回静默。 */
  removeSession(conversationId: string): Promise<{ removed: boolean }>;
  dispose(): Promise<void>;
}

let runtimePromise: Promise<DshRuntime | null> | null = null;

/** `ensureAgent` 用的最小 agent handle 形状。agents.create / agents.resume
 *  都返回这个形状；测试不需要完整 Agent 接口。 */
export interface AgentHandle {
  agent: {
    followup(m: unknown): void;
    whenIdle(): Promise<void>;
    cancel(
      cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' },
      options?: { keepInbox?: boolean },
    ): void;
    id: unknown;
  };
  dispose(): Promise<void>;
}

/** resumeOrCreate 需要的最小持久化外观 */
export interface PersistenceFacade {
  load?: (id: string, signal?: AbortSignal) => Promise<unknown>;
  list?: (signal?: AbortSignal) => Promise<ReadonlyArray<SessionListEntry>>;
}

// ===== 0.1.5-rc.2 dsh-session-persistence-jsonl read API =====
//
// The persistence API changed between 0.1.2-rc.1 and 0.1.5-rc.2:
//   0.1.2-rc.1: `load(id)` / `inspect(id, signal)` → `{ meta, events }`
//   0.1.5-rc.2: `open(id, 'read')` → a SessionHandle; `handle.read(o, len)` →
//                `{ events }`; `handle.close()` to release. There is NO `load`.
// We locked `@deepseek-ai/dsh-session-persistence-jsonl` to 0.1.5-rc.2, so the
// old `persistenceApi.load(id)` call sites threw "persistenceApi.load is not a
// function" → loadHistory() / migrateOrphanSessions() silently returned [].
// `readSessionEvents` is the single 0.1.5-rc.2-shaped read path both callers
// use. `open` lives on the prototype (not an own key, so it's absent from
// `Object.keys()` diagnostics) but IS present on the instance.

/** Read handle returned by `SessionPersistence.open(id, 'read')` in 0.1.5-rc.2. */
interface SessionReadHandle {
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{
    events: ReadonlyArray<{ type: string; data?: unknown }>;
  }>;
  close(): Promise<void>;
}

/** The 0.1.5-rc.2 `JsonlSessionPersistence` surface we use. `open` replaces
 *  the removed `load`/`inspect`; `list` is unchanged. */
interface SessionPersistence015 {
  open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<SessionReadHandle>;
  // `list` returns one entry per stored session, but its element shape is
  // backend-dependent: the JSONL backend's own override returns bare
  // `SessionHeader[]` (`{id, createdAt, ...}`), while the base service contract
  // returns `SessionPersistenceSnapshot[]` (`{header: {id, createdAt, ...},
  // revision, ...}`). Callers must normalize via `sessionListId`/`sessionListCreatedAt`.
  list?(signal?: AbortSignal): Promise<ReadonlyArray<SessionListEntry>>;
  config?: { root?: string };
}

/** One element of `SessionPersistence.list()` — covers both the bare-header
 *  and the snapshot-with-header shapes. */
interface SessionListEntry {
  id?: string;
  createdAt?: number;
  header?: { id?: string; createdAt?: number };
}

/** Extract the session id from a `list()` entry regardless of shape. */
function sessionListId(entry: SessionListEntry): string | undefined {
  const id = entry.id ?? entry.header?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Extract createdAt (ms) from a `list()` entry regardless of shape. */
function sessionListCreatedAt(entry: SessionListEntry): number | undefined {
  const ts = entry.createdAt ?? entry.header?.createdAt;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
}

/** Read all persisted events for a session via the 0.1.5-rc.2 open/read/close
 *  API. Returns [] when persistence is unavailable or the session isn't
 *  persisted yet (fresh conversation) — never throws. */
async function readSessionEvents(
  persistence: SessionPersistence015 | undefined,
  id: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<{ type: string; data?: unknown }>> {
  if (!persistence?.open) return [];
  let handle: SessionReadHandle | undefined;
  try {
    handle = await persistence.open(id, 'read', signal ? { signal } : undefined);
  } catch {
    // Not persisted (fresh conversation) or backend unavailable — no history.
    return [];
  }
  try {
    const result = await handle.read(0, Number.MAX_SAFE_INTEGER, signal ? { signal } : undefined);
    return result.events;
  } finally {
    try { await handle.close(); } catch { /* noop */ }
  }
}
export interface AgentsFacade {
  create(o: { sessionId: string; agentOptions?: { provider?: string; model?: string } }): Promise<AgentHandle>;
  resume(o: { resumeSessionId: string; agentOptions?: { provider?: string; model?: string } }): Promise<AgentHandle>;
}

/** 最小日志外观，有 .warn/.info 即可 */
export interface ResumeLogger {
  warn: (msg: string) => void;
  info: (msg: string) => void;
}

/** resumeOrCreate 的依赖。打包好让 helper 保持纯净，可单独单测。 */
export interface ResumeOrCreateDeps {
  agents: AgentsFacade;
  persistence?: PersistenceFacade;
  logger: ResumeLogger;
}

/**
 * 会话已经有持久化日志时，优先 `agents.resume({ resumeSessionId })` 而不是
 * `agents.create({ sessionId })`。
 *
 * 原因：create() 在已有 id 上会走 `ctx.sessions.prepare(id, { meta })` 并带
 * 空 seed。持久化协调器的 `session/created` 监听器随后跑 `onCreated`，在
 * `coordinator.ts:1256` 触发 `seedMatchesPersisted` 抛 "session ... is already
 * persisted with N event(s) that do not match this live session (id collision)"。
 * 这个 throw 会被 `void this.initFor(session)` 静默吞掉，但渲染端下一轮
 * `loadHistory()` 调用（每次打开 app 都会跑）会把拒绝以
 * `loadHistory(id) failed: ... (id collision)` 的形式重新抛出。
 *
 * resume() 走 `persistence.prepare(id)`，先把持久化的事件灌进 Session seed，
 * 这样 `seedMatchesPersisted` 通过，碰撞永远不会触发。
 *
 * 回落到 create() 模仿 DSH 自家的 `restoreOrCreateConfigured`
 * (packages/core/agent-loop/src/index.ts:407)：resume 失败时只在"日志真的不
 * 存在"时回落；损坏的日志必须保持响亮，提示用户而不是被新空会话覆盖。
 *
 * 导出供单测验证 resume-vs-create 分支，不必启动完整 DSH 运行时。
 */
export async function resumeOrCreate(
  deps: ResumeOrCreateDeps,
  conversationId: string,
  agentOptions: { provider: string; model: string },
): Promise<AgentHandle> {
  let resumeError: unknown;
  try {
    return await deps.agents.resume({
      resumeSessionId: conversationId,
      agentOptions,
    });
  } catch (err) {
    resumeError = err;
  }
  // 直接问后端区分"无持久化日志"和"损坏/后端故障"：确认缺失才回落 create()，
  // 其他情况保持响亮，避免空会话覆盖坏日志。
  let isAbsent = false;
  if (deps.persistence?.list) {
    try {
      const headers = await deps.persistence.list();
      isAbsent = !headers.some((h) => sessionListId(h) === conversationId);
    } catch (err) {
      // list() 失败 → 无法判断，保留 resume 错误响亮抛出
      deps.logger.warn(`resumeOrCreate(${conversationId}): persistence.list() failed during fallback probe: ${(err as Error).message}`);
      throw resumeError;
    }
  }
  if (!isAbsent) {
    deps.logger.warn(`resumeOrCreate(${conversationId}): resume failed for an existing persisted session, not falling back: ${(resumeError as Error).message}`);
    throw resumeError;
  }
  deps.logger.info(`resumeOrCreate(${conversationId}): no persisted session; creating fresh agent`);
  return deps.agents.create({
    sessionId: conversationId,
    agentOptions,
  });
}

// ===== L4-G: Human-in-the-loop 桥接 =====
//
// DSH 提供 user-questions + user-approval 的插件入口
// （@deepseek-ai/dsh-user-questions + @deepseek-ai/dsh-user-approval）但没
// 配套的 answerer 包。我们在 bootDsh() 里注册 waterfall 监听器，每次提问
// 都广播给所有 BrowserWindow，通过 `ai.userQuestion.answer` /
// `ai.userApproval.answer` IPC 通道等待结构化答复。
//
// 90s 自动取消：用户走开会超时——不希望 agent loop 永远阻塞。挂个 setTimeout
// 在超时时 reject ASK_ABORTED；同一定时器触发时通知渲染端把卡片翻成
// "已超时"，通过 `ai:user-question-timeout` / `ai:user-approval-timeout`。
//
// 所有状态在模块作用域（不在 runtime 实例上），因为 main/index.ts 的 IPC
// handler 注册早于 DSH boot——router 已经校过通道，但 handler 还得解析那些
// 等着瀑布 promise 的 pending 状态，那时 runtime 还没准备好。下面的函数
// 是这个桥的应答侧。

/** 等待用户答复的最长时间，超时自动取消 */
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

/** 渲染端应答 ai.userQuestion.answer 时调用。reqId 找不到 pending 条目
 *  （超时/重复）返回 false。渲染端把完整 { reqId, answers } 给我们，我们
 *  用同样的形状 resolve waterfall promise。 */
export function answerUserQuestion(reqId: string, answers: UserQuestionAnswer['answers']): boolean {
  const entry = pendingQuestions.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingQuestions.delete(reqId);
  entry.resolve({ reqId, answers });
  return true;
}

/** 渲染端应答 ai.userApproval.answer 时调用。把渲染端的简化词表
 *  ('allow-once' | 'reject') 映射到 DSH 的 ApprovalOutcome
 *  ('allowed-once' | 'rejected')。'cancelled' 和 'unavailable' 留给超时/
 *  无 answerer 路径。 */
export function answerUserApproval(reqId: string, decision: 'allow-once' | 'reject'): boolean {
  const entry = pendingApprovals.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingApprovals.delete(reqId);
  entry.resolve(decision === 'allow-once' ? 'allowed-once' : 'rejected');
  return true;
}

/** dispose() 时清空所有 pending —— runtime 拆掉时不留僵尸定时器 */
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

/** 给渲染端构造 UserQuestionRequest payload。抽出来让 waterfall 监听器
 *  一行写完 */
function questionRequestPayload(reqId: string, request: { questions: ReadonlyArray<{ id: string; question: string; detail?: string; header?: string; options?: ReadonlyArray<{ label: string; description?: string }>; multiSelect?: boolean }> }): UserQuestionRequest {
  return {
    reqId,
    // invocationId 不在 DSH request 形状里；渲染端只按 reqId 关联（要加就得
    // 在 ctx.userQuestions.ask 上额外走 LLM adapter，不值当）
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
 * L3-C：给磁盘上有 JSONL 但 DB 没对应行的 session 补行。
 *
 * 原因：L2 之前渲染端没有多会话模型，早期 DSH runtime / 测试 adapter 跑出来的
 * session 直接落到磁盘，没写过 `conversations` 表。L2 之后这些孤儿对新
 * AIPane 不可见——JSONL 日志还在，但没有 DB 行就没法在侧边栏加载。
 *
 * 做法：遍历持久化后端的 session 列表，与 DB 行比对，每个孤儿：
 *   1. persistence.load(id) 读事件流
 *   2. 取第一条 user/message 文本（DSH 形状 data.content[] 内 {type:'text'}）
 *      截到 TITLE_MAX，超长加 …
 *   3. INSERT 一行，created_at 用 session.createdAt（持久化插件在打开 session
 *      时记录的 mtime），updated_at 用 Date.now()，让新行浮到侧边栏顶部直到
 *      用户真的使用它
 *
 * 可重复调用（idempotent，跳过已有行）。在 bindAiDeps 之后跑，确保首挂 AIPane
 * 就能看到迁移的行。
 *
 * 标题启发式：取第一条 user prompt 反映意图最稳定。后续不更新（L3-D 自动重命名
 * 留给后续）。第一条 user message 为空的孤儿（罕见——开了 session 没发消息）
 * 退回默认 `未命名对话`。
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
    const sid = sessionListId(entry);
    if (!sid) {
      // No usable id (e.g. a snapshot whose header is missing). Skip rather
      // than insert a junk row we could never de-dupe or re-attach.
      failed++;
      continue;
    }
    if (conversations.get(sid)) {
      skipped++;
      continue;
    }
    let title = '未命名对话';
    try {
      const events = await persistence.readEvents(sid);
      const firstUser = extractFirstUserText(events);
      if (firstUser) title = truncateTitle(firstUser, TITLE_MAX);
    } catch (err) {
      logger.warn(`migrateOrphanSessions(${sid}): readEvents failed, using default title: ${(err as Error).message}`);
    }
    try {
      const row = conversations.create({ title });
      // created_at 反映原 session 创建时间而非迁移时间——否则侧边栏把 L2 之前
      // 的会话错误地顶到最前。updated_at 留"现在"，让行浮顶直到用户真用它。
      // 直接走底层 handle 改 created_at，公开 API 故意不暴露（仅作回填）。
      const createdMs = sessionListCreatedAt(entry);
      if (createdMs !== undefined) {
        (conversations as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
          .prepare('UPDATE conversations SET created_at = ? WHERE id = ?')
          .run(createdMs, row.id);
      }
      logger.info(`migrateOrphanSessions: backfilled ${row.id} "${title}" (session=${sid}, created=${createdMs !== undefined ? new Date(createdMs).toISOString() : 'unknown'})`);
      migrated++;
    } catch (err) {
      logger.warn(`migrateOrphanSessions(${sid}): insert failed: ${(err as Error).message}`);
      failed++;
    }
  }
  logger.info(`migrateOrphanSessions: ${migrated} migrated, ${skipped} already present, ${failed} failed (total ${list.length})`);
}

/** 标题截到 maxChars，超长加 … */
function truncateTitle(s: string, maxChars: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + '…';
}

/** DSH runtime-context / system 注入的 user/message：source.kind 是 plugin 或 system。
 *  这些不是用户真正说的话（如 "Current runtime context…"），不应渲染成用户气泡，
 *  也不应用作会话标题。 */
function isInjectionUserMessage(data: unknown): boolean {
  const d = data as { source?: { kind?: string } } | undefined;
  return d?.source?.kind === 'plugin' || d?.source?.kind === 'system';
}

/** 从 DSH 事件流里取第一条 user/message 文本（跳过运行时上下文注入）。
 *  通过共享解码函数剥离封套前缀 / JSON——返回的永远是用户视角的明文，
 *  否则会话标题会变成 "[todo-list:create-task:v1] {…}" 这种泄露。 */
function extractFirstUserText(events: ReadonlyArray<{ type: string; data?: unknown }>): string {
  for (const ev of events) {
    if (ev.type !== 'user/message') continue;
    if (isInjectionUserMessage(ev.data)) continue;
    const d = ev.data as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = (d?.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text) return decodeUserMessage(text).text;
  }
  return '';
}

// --- 迁移辅助 ---
//
// 迁移需要持久化层的 list/load，而 list/load 在 runtime boot 里。如果把
// 持久化层当 runtime 公开方法（会和 runtime 内部耦合），不如再启一次只跑
// 持久化——便宜、隔离、无副作用。~50ms 且只跑一次（首次开 app 时）。

/** 启一个最小 cordis 树，只挂 session persistence 插件，返回 list()/readEvents()。
 *  失败返回 null。 */
async function bootPersistenceOnly(): Promise<{
  list: () => Promise<ReadonlyArray<SessionListEntry>>;
  readEvents: (id: string) => Promise<ReadonlyArray<{ type: string; data?: unknown }>>;
} | null> {
  try {
    const cfg = resolveAppPath('resources/dsh/cordis.yml');
    if (!cfg || !existsSync(cfg)) return null;
    const appRoot = app.getAppPath();
    const bareBase = new URL('.', pathToFileURL(appRoot).href).href;
    const bootMod = await import('@deepseek-ai/dsh-app-boot');
    const { boot } = bootMod;
    const ctx = (await boot('todo-list-migrate', cfg, undefined, undefined, bareBase)) as DshContext;
    // 0.1.5-rc.2: persistence exposes `open(id,'read')` + `list`, NOT `load`.
    const persistence = ctx.get('sessionPersistence') as SessionPersistence015 | undefined;
    if (!persistence?.list || !persistence?.open) {
      await ctx.fiber?.dispose?.();
      return null;
    }
    return {
      list: () => persistence.list!(),
      readEvents: (id) => readSessionEvents(persistence, id),
    };
  } catch (err) {
    logger.warn(`bootPersistenceOnly failed: ${(err as Error).message}`);
    return null;
  }
}

/** DSH 懒启动一次；失败返回 null（渲染端会显示"DSH unavailable"，无回退路径） */
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
  const cfg = resolveAppPath('resources/dsh/cordis.yml');
  if (!cfg || !existsSync(cfg)) {
    logger.warn('DSH cordis.yml not found; skipping boot');
    return null;
  }
  // bareModuleBaseUrl 把裸 @deepseek-ai/dsh-* 锚到已装包树。dev 模式用项目根，
  // 打包后用持有 node_modules 的 app 目录。
  const appRoot = app.getAppPath();
  const bareBase = new URL('.', pathToFileURL(appRoot).href).href;

  const bootMod = await import('@deepseek-ai/dsh-app-boot');
  const { boot } = bootMod;
  const ctx = (await boot('todo-list', cfg, undefined, undefined, bareBase)) as DshContext;

  // 暴露持久化层：列出 <DSH_SESSIONS_ROOT> 下已有的会话，让用户从日志里看到
  // 历史会话保存情况。每次启动都跑一遍没事——list() 只走目录不读事件。
  try {
    const persistence = ctx.get('sessionPersistence') as SessionPersistence015 | undefined;
    if (persistence?.list) {
      const stored = await persistence.list();
      const root = persistence.config?.root ?? process.env['DSH_SESSIONS_ROOT'] ?? '(unset)';
      if (stored.length === 0) {
        logger.info(`DSH persistence: 0 sessions stored under ${root}`);
      } else {
        const ids = stored.map((s) => sessionListId(s) ?? '(no-id)').join(', ');
        logger.info(`DSH persistence: ${stored.length} session(s) stored under ${root}: ${ids}`);
      }
    }
  } catch (err) {
    // list 失败不阻塞 boot——这里只是可观测性，不是关键依赖
    logger.warn(`DSH persistence list failed (non-fatal): ${(err as Error).message}`);
  }

  // 1. 注册 LLM adapter 到所有真 provider 路由。PiAiAdapter 每条路由一个
  //    pi-ai 后端 provider；profiles() 每次操作重读设置，key/endpoint/model
  //    改了无需重启即下次请求生效。
  const llm = ctx.get('llm') as { registerAdapter(providers: string[], adapter: unknown): () => void } | undefined;
  if (!llm) throw new Error('DSH booted but ctx.llm is absent');
  const { createLlmAdapters, REAL_PROVIDER_ROUTES } = await import('./llm-adapter');
  const { real: llmAdapter } = createLlmAdapters({
    getEndpoint: deps.getEndpoint,
    getCustomProviders: () => deps.settings.get().customProviders,
    getCustomProviderId: () => deps.settings.get().customProviderId,
  });
  const disposeAdapter = llm.registerAdapter([...REAL_PROVIDER_ROUTES], llmAdapter);
  void REAL_PROVIDER_ROUTES;

  // 2. 注册我们的领域工具
  const tools = ctx.get('tools') as { register(def: unknown): () => void } | undefined;
  if (!tools) throw new Error('DSH booted but ctx.tools is absent');
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const disposeTools = registerDomainTools(tools, defineTool, deps, ctx);

  // 3. 会话注册表：每个会话一个 agent handle，缓存到会话生命周期结束。
  //    ensureAgent() 幂等——同 id 再调直接返回已有 entry。
  const agentsApi = ctx.get('agents') as {
    create(o: unknown): Promise<{
      agent: {
        followup(m: unknown): void;
        whenIdle(): Promise<void>;
        /** L3-A 软取消：abort 当前轮次但保留 agent 句柄。
         *  keepInbox=false 时清空排队的 steering；没有活动就什么都不做。 */
        cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }, options?: { keepInbox?: boolean }): void;
        id: unknown;
      };
      dispose(): Promise<void>;
    }>;
    resume(o: unknown): Promise<{
      agent: {
        followup(m: unknown): void;
        whenIdle(): Promise<void>;
        cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }, options?: { keepInbox?: boolean }): void;
        id: unknown;
      };
      dispose(): Promise<void>;
    }>;
  } | undefined;
  if (!agentsApi) throw new Error('ctx.agents absent');

  // 永久监听器：把 DSH session-title 服务产生的 `session/title` 事件同步到
  // 本地 conversations DB。两种来源：
  //   1. 第一条可用 user message 之后回退式生成的截断摘要
  //   2. 可选 LLM provider（dsh-session-title-first-prompt-llm）异步汇总的结果
  // 两种都流经这里。我们只负责把 DB 行的标题改成到来的标题，再广播
  // app:data-changed { scope: 'conversations' } 让 AIPane / 侧边栏无需重拉。
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
      // session 存在但 DB 行还没——渲染端还没建（或者 migrateOrphanSessions
      // 还在跑）。跳过，下一次 create() / 迁移会从 session log 取到标题。
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

  // L4-G: DSH 不提供 user-questions / user-approval 的 answerer，我们装
  // waterfall 监听器把每次提问广播给渲染端（内联卡片），再通过
  // answerUserQuestion / answerUserApproval IPC 等答复。90s 自动取消，
  // 避免用户走开时 agent loop 永久阻塞。
  ctx.on('user-questions/request', (request: {
    questions: ReadonlyArray<{ id: string; question: string; detail?: string; header?: string; options?: ReadonlyArray<{ label: string; description?: string }>; multiSelect?: boolean }>;
  }, _next: () => Promise<unknown>): Promise<UserQuestionAnswer> => {
    const reqId = randomUUID();
    return new Promise<UserQuestionAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pendingQuestions.get(reqId);
        if (!entry) return; // 已 settle
        pendingQuestions.delete(reqId);
        // 通知渲染端卡片翻成"已超时自动取消"，让 UI 与 agent 实际状态一致
        // （loop 会收到 ASK_ABORTED 继续往下走）
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

  // 二元审批的对称实现。DSH 把 answerer 返回值归一为四种结局；渲染端路径
  // 只 resolve 'allowed-once' / 'rejected'（超时 resolve 'unavailable'，
  // signal abort resolve 'cancelled'）。
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
      const timer = setTimeout(() => {
        settle('unavailable');
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('ai:user-approval-timeout', { reqId });
        }
      }, INTERACTION_TIMEOUT_MS);
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

  // 0.1.5-rc.2 persistence surface: `open(id,'read')` + `list`. The old
  // `load(id)` API was removed in 0.1.5-rc.2; loadHistory()/migrateOrphan*()
  // go through readSessionEvents() which uses open/read/close. `open` lives
  // on the prototype (absent from Object.keys) but is present on the instance.
  const persistenceApi = ctx.get('sessionPersistence') as SessionPersistence015 | undefined;
  if (persistenceApi) {
    logger.info(
      `sessionPersistence ready: ctor=${persistenceApi.constructor?.name ?? '(n/a)'}` +
      ` hasOpen=${typeof persistenceApi.open === 'function'}` +
      ` hasList=${typeof persistenceApi.list === 'function'}`,
    );
  } else {
    logger.warn('sessionPersistence: ctx.get returned undefined; history will be empty');
  }

  interface ConversationEntry {
    id: string;
    agent: {
      followup(m: unknown): void;
      whenIdle(): Promise<void>;
      cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }, options?: { keepInbox?: boolean }): void;
      id: unknown;
    };
    disposeHandle: () => Promise<void>;
    /** 退订每会话的 session/event 监听器 */
    offSession: () => void;
    /** true 表示当前无消费者在读事件（轮次间） */
    dormant: boolean;
  }

  const conversations = new Map<string, ConversationEntry>();

  async function ensureAgent(conversationId: string, model: string): Promise<ConversationEntry> {
    const existing = conversations.get(conversationId);
    if (existing) return existing;

    // 从当前设置选已注册的 PiAiAdapter 路由。每条会话缓存自己的 agent
    // handle——用户在两轮之间改 settings.provider，新值下次新建会话生效，
    // 在跑的会话仍走原路由直到 dispose（disposeConversation）。
    const { providerRouteFor } = await import('./llm-adapter');
    const provider = providerRouteFor(deps.settings.get().provider) ?? 'deepseek';

    // 总是 resume() 优先（会话有持久化日志时）。create() 在已有 id 上会撞
    // `seedMatchesPersisted` 抛 id collision；详见 resumeOrCreate 的注释。
    const handle = await resumeOrCreate(
      {
        // runtime 的 agentsApi 把 create/resume 都声明成 o: unknown——包一层
        // 类型化的 facade 让 resumeOrCreate 保持纯净可单测。
        agents: agentsApi as unknown as AgentsFacade,
        persistence: persistenceApi,
        logger,
      },
      conversationId,
      { provider, model },
    );

    const entry: ConversationEntry = {
      id: conversationId,
      agent: handle.agent,
      disposeHandle: () => handle.dispose(),
      offSession: () => {},
      dormant: true,
    };
    conversations.set(conversationId, entry);
    return entry;
  }

  // 不挂永久监听器——轮次间没有消费者，挂上只会泄漏 onEvent callable。
  //
  // 透传策略：attachLiveListener 只做"按 conversationId 过滤 + 原样投递"两件事。
  // 以前这里会把 raw DSH event 翻译成本地 TurnEvent（token / reasoning /
  // toolCall / toolResult / done），但合成语义和真实 cordis 事件流开始脱节
  // （done 是 runtime 自创，token / reasoning 都从 assistant/chunk 一种 chunk
  // 形态挑出来的），不如把整条原始流上抛给关心语义的层（ai.ask）去翻译。
  // 累积本轮 fullText / tokens 的小工作留在 runTurn 的闭包里，避免给监听器
  // 加额外职责。
  //
  // 过滤：ctx.on('session/event', ...) 对所有 active session 触发，所以按
  // session.id === conversationId 过滤，让并行会话的事件流互不干扰。
  function attachLiveListener(
    entry: ConversationEntry,
    onEvent: (e: DshRawEvent) => void,
  ): () => void {
    const off = ctx.on('session/event', (session: unknown, event: DshRawEvent) => {
      const sid = (session as { id?: unknown } | undefined)?.id;
      if (String(sid) !== entry.id) return;
      onEvent(event);
    });
    // 0.1.5-rc.2 的 session 层不把 per-token chunk 作为 session 事件广播——
    // BlockAssembler 在 llm 层消费 adapter 的 stream() AsyncIterable，只把组装
    // 好的 assistant/message 作为 session 事件抛出，故 runTurn / 渲染端监听
    // session 事件总线时永远收不到 assistant/chunk，渲染表现为"思考中…"然后
    // 整段答案一次蹦出。
    //
    // 统一架构的解法：在 LlmRuntime 的 'llm/stream' waterfall（DSH 官方扩展点，
    // dsh-session-title 也用）上挂一个**本轮**监听器，包住 next()，把 text-delta
    // / reasoning-delta chunk 作为合成的 assistant/chunk 事件送进**同一条**
    // onEvent——runTurn 的 fullText 累积、渲染端的 token/reasoning 通道原样复用。
    // 不短接：每个 chunk 原样 yield，assembler 照常组装 assistant/message；只桥
    // 主回复（options.purpose 为空，且 sessionId === 本会话），session-title /
    // compaction 的流不进用户聊天。本轮结束即卸载，无全局状态。
    const llmStreamCtx = ctx as unknown as {
      on(
        event: 'llm/stream',
        handler: (
          options: { sessionId?: unknown; purpose?: string },
          next: () => AsyncIterable<StreamChunkLike>,
        ) => AsyncIterable<StreamChunkLike>,
        opts?: { global?: boolean },
      ): () => void;
    };
    const offStream = llmStreamCtx.on('llm/stream', (options, next) => {
      if (options.purpose) return next();
      const streamSid = options.sessionId != null ? String(options.sessionId) : undefined;
      if (streamSid !== entry.id) return next();
      return bridgeLlmStream(next(), onEvent);
    });
    entry.offSession = () => {
      try { off(); } catch { /* noop */ }
      try { offStream(); } catch { /* noop */ }
    };
    entry.dormant = false;
    return entry.offSession;
  }

  // 4. 暴露 runtime API
  const runtime: DshRuntime = {
    async runTurn({ prompt, conversationId, invocationId, intent, onEvent, signal }) {
      void invocationId; // 留作对外 API 兼容；事件流里的 invocationId 由 ai.ask 自行追踪
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
      const endpoint = deps.getEndpoint();
      const model = endpoint?.model ?? 'deepseek-chat';
      const entry = await ensureAgent(conversationId, model);
      // Create-task envelope assembly lives here, not in the renderer: the
      // fixed creation rules (default status, conservative priority, etc.)
      // are in the DSH system prompt (resources/dsh/cordis.yml), so the wire
      // envelope only carries the prefix + JSON {intent, localDate, text}.
      // Chat turns keep the literal user text verbatim.
      const wirePrompt = intent === 'create-task'
        ? encodeTaskCreationEnvelope(prompt)
        : prompt;
      // L4-E：监听器只做透传，本轮 fullText / tokens 在闭包里累加并最终
      // 写进 runTurn 的返回值。ai.ask 用返回的 tokens 算价格、用 fullText
      // 当 AIStreamEvent.done.content，不再依赖一条合成的 'done' 事件。
      let fullText = '';
      let turnTokensIn = 0;
      let turnTokensOut = 0;
      // Per-step chunk accumulator. The adapter streams the answer as
      // `assistant/chunk` text-deltas; the final `assistant/message` event
      // that closes a step carries `usage` and, when the adapter did NOT
      // stream (non-streaming provider / one-shot reply), the answer text
      // itself in `data.message.content[].text`. foldHistory() already
      // applies this fallback for persisted history; mirror it here so
      // `done.content` carries the answer and the renderer (T2 Fix B) can
      // seed a text block. When chunks DID flow, `stepChunkText` is non-empty
      // and the message's text block is empty (DSH serializes a streamed
      // answer into chunks, not the final message) — so we only read the
      // message text when no chunks arrived this step, avoiding double-count.
      let stepChunkText = '';
      const off = attachLiveListener(entry, (event) => {
        if (event?.type === 'assistant/chunk') {
          const d = event.data as { chunk?: { type?: string; text?: string } } | undefined;
          const chunk = d?.chunk;
          // text-delta 累加成当轮可见文本；reasoning-delta 不入 fullText，
          // 它有独立 UI 通道（ai.ask 会把 reasoning-delta 翻译成 reasoning 流事件）
          if (chunk?.type === 'text-delta' && chunk.text) {
            stepChunkText += chunk.text;
            fullText += chunk.text;
          }
        } else if (event?.type === 'assistant/message') {
          const d = event.data as {
            usage?: { inputTokens?: number; outputTokens?: number };
            message?: { content?: Array<{ type?: string; text?: string }> };
          } | undefined;
          if (d?.usage) {
            turnTokensIn  += d.usage.inputTokens  ?? 0;
            turnTokensOut += d.usage.outputTokens ?? 0;
          }
          // Fallback: no chunks streamed this step → the answer text lives in
          // the final message's content blocks. Append to fullText so done
          // .content is non-empty. (Mirrors foldHistory's assistant/message
          // fallback — see dsh-runtime.ts foldHistory().)
          if (!stepChunkText) {
            const blocks = d?.message?.content ?? [];
            const msgText = blocks
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('');
            if (msgText) fullText += msgText;
          }
          stepChunkText = '';
        } else if (event?.type === 'step/end' || event?.type === 'turn/end') {
          stepChunkText = '';
        }
        onEvent(event);
      });
      try {
        const userMsg = createUserMessage({
          content: [{ type: 'text', text: wirePrompt }],
          source: { kind: 'user' },
        });
        entry.agent.followup(userMsg);
        // 协作式取消：渲染端取消时软中止 agent。L3-A 偏好 agent.cancel
        // ({kind:'user'}) 而非销毁 handle——agent 留下，next followup() 复用
        // 同 session 不必重 resume。whenIdle() 在被中止的轮次收敛到 idle 时
        // 自行 resolve。无活跃轮次时调用是 no-op（DSH 文档），对伪 abort
        // 信号也安全。
        signal?.addEventListener('abort', () => {
          try { entry.agent.cancel({ kind: 'user' }); } catch { /* noop */ }
        });
        await entry.agent.whenIdle();
        return { content: fullText, tokensIn: turnTokensIn, tokensOut: turnTokensOut };
      } finally {
        try { off(); } catch { /* noop */ }
        entry.dormant = true;
      }
    },

    async cancel(conversationId) {
      const entry = conversations.get(conversationId);
      if (!entry) return;
      // L3-A 软取消：handle 留在缓存里，下次 followup() 走同 agent + 持久化
      // session。硬销毁留给 disposeConversation（ai.conversation.delete 路径）。
      //
      // - 轮次在跑：agent.cancel({kind:'user'}) 中断它，whenIdle() 快速
      //   resolve。在它前面的 text/tool 事件已经流过，会成为持久化日志的一部分，
      //   loadHistory() 仍如实返回。
      // - 闲置：cancel 是 no-op（DSH 文档），安全调用。
      try { entry.agent.cancel({ kind: 'user' }); } catch { /* noop */ }
      // 不 conversations.delete()——下次 ask() 会触发 re-resume，丢掉刚刚
      // 积攒的 agent 内部缓存（已解析的 system prompt、pre-step 决策）。
    },

    async loadHistory({ conversationId }) {
      if (!persistenceApi) return [];
      // 0.1.5-rc.2: persistence exposes `open(id,'read')` + `handle.read()`,
      // not `load(id)` (that API was removed in 0.1.5-rc.2 — see
      // readSessionEvents). readSessionEvents returns [] for a fresh / missing
      // session, so foldHistory([]) = [] is the honest "no history yet".
      const events = await readSessionEvents(persistenceApi, conversationId);
      return foldHistory(events);
    },

    async disposeConversation(conversationId) {
      const entry = conversations.get(conversationId);
      if (!entry) return;
      conversations.delete(conversationId);
      try { entry.offSession(); } catch { /* noop */ }
      try { await entry.disposeHandle(); } catch { /* noop */ }
    },

    async removeSession(conversationId) {
      // JSONL 插件没暴露 delete 方法（设计上 append-only）——我们手动遍历
      // 持久化根目录，删掉每个 <root>/<sanitized-project>/<sessionId>/。
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
          // 可能有多个 project 目录（不同 cwd 上下文），全删干净才算彻底清除。
        }
      } catch (err) {
        logger.warn(`removeSession(${conversationId}) failed: ${(err as Error).message}`);
      }
      return { removed };
    },

    async dispose() {
      // L4-G: 先把挂着的 HITL waterfall 都 drain 掉再拆 cordis fiber——
      // 不然 90s 定时器会往半关闭的 runtime 上 fire，BrowserWindow.getAllWindows()
      // 已经找不到 listener。用 reject('aborted') / resolve('cancelled') settle，
      // DSH 的工具循环解除阻塞，模型侧显示一个干净的"已取消"。
      cancelAllPending();
      // 先拆所有会话 handle（每个 dispose 都等自己的 whenIdle + cleanup），
      // 再拆 cordis fiber。
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
 * 把会话事件日志折叠成 HistoryTurn 平铺列表。
 *
 * - user/message → 一个 user turn（拼接所有 text block）。注意 user 的
 *   data 形如 `content: [{type, text}]`（不是 assistant 那种 `message.content`）。
 * - assistant/text → 由 step 边界之间的 `assistant/chunk` text-delta 拼起来。
 *   最终 `assistant/message` 事件的 `data.message.content` 里 text block 经常
 *   为空（流式答案在 chunks 里，不在 final 事件里——DSH 的序列化怪癖），
 *   所以以 chunks 为准。reasoning 内容从 reasoning-delta 聚合后挂到
 *   assistant turn 的 `reasoning` 字段。
 * - tool/call + tool/result → 一个 tool turn（按 callId 配对）。
 *   - 都按真实 callId 配对；同一次会话里多次同名调用走不同 callId。
 *   - 缺失 result 不自动等于执行失败——只在 `error` / `stopped` 状态下
 *     标红；`missing-result` 是中性提示。
 *   - `cancelled:` 前缀的结果标记为 `stopped`（琥珀色，非红色）。
 *   - 只有 result 没有 call 的情况（理论）→ `state: 'missing-call'` +
 *     `argsKnown: false`，渲染端兜底显示「工具调用信息缺失」/「未记录输入」。
 * - 结构事件（turn/start、step/end）跳过，只用作 assistant 文本 flush 边界。
 *
 * L3-I: 导出给 vitest 直接单测。形状测试在 tests/dsh-runtime-foldHistory.test.ts，
 * 锁住本函数依赖的事件形——DSH 升级改了 chunks / final messages 的序列化时
 * 防止悄悄回归。
 */
export function foldHistory(events: ReadonlyArray<{ type: string; data?: unknown }>): HistoryTurn[] {
  const turns: HistoryTurn[] = [];

  // First pass: index tool/result by callId so tool/call can pair with it
  // even when the result landed first (chunks arrive out-of-order under load).
  // Orphan results (no source.callId) are buffered separately and emitted
  // at the end of pass 2 — defensive only, real DSH sessions always carry
  // a callId on tool/result.
  const pendingResults = new Map<string, { ok: boolean; data?: unknown; presentationMeta?: unknown; error?: string }>();
  const orphanResults: Array<{ block: { isError?: boolean; content?: unknown[] } | undefined; presentationMeta: unknown }> = [];
  for (const ev of events) {
    if (ev.type === 'tool/result') {
      const d = ev.data as {
        message?: {
          source?: { callId?: unknown };
          content?: Array<{ isError?: boolean; content?: unknown[] }>;
        };
        meta?: unknown;
      } | undefined;
      const rawCallId = d?.message?.source?.callId;
      const block = d?.message?.content?.[0];
      if (rawCallId != null) {
        pendingResults.set(String(rawCallId), {
          ok: !block?.isError,
          data: block?.content,
          presentationMeta: d?.meta,
          error: block?.isError ? JSON.stringify(block?.content) : undefined,
        });
      } else {
        orphanResults.push({ block, presentationMeta: d?.meta });
      }
    }
  }

  let orphanSynthCounter = 0;

  // Helper: classify a tool/result's terminal state. Mirrors stream-turn.ts'
  // `handleToolResult` — `cancelled:` prefix ⇒ stopped, not error.
  const classifyResult = (
    ok: boolean,
    data: unknown,
    error: string | undefined,
  ): 'done' | 'error' | 'stopped' => {
    if (ok) return 'done';
    const recovered = recoverToolResultValue(data);
    if (typeof recovered === 'string' && recovered.startsWith('cancelled:')) return 'stopped';
    // Preserve explicit error string; otherwise unknown failure.
    void error;
    return 'error';
  };

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

  const emitOrphan = (orphan: { block: { isError?: boolean; content?: unknown[] } | undefined; presentationMeta: unknown }): void => {
    flushAssistant();
    const ok = !orphan.block?.isError;
    const data = orphan.block?.content;
    const resultState = classifyResult(ok, data, undefined);
    turns.push({
      type: 'tool',
      // Synthesised callId — orphan results never carried a source.callId,
      // and we mint a stable per-position id so React keys don't churn if
      // the user reloads.
      callId: `orphan-${orphanSynthCounter++}`,
      name: '',
      args: undefined,
      ok,
      data,
      presentationMeta: orphan.presentationMeta,
      // `missing-call` always — there is no tool/call, so the renderer
      // falls back to "工具调用信息缺失" + "未记录输入". The result-side
      // state (done / stopped / error) is preserved as `ok` and `error`
      // so the status dot still tells the truth about the execution.
      error: ok ? undefined : resultState === 'stopped' ? undefined : JSON.stringify(data),
      state: 'missing-call',
      argsKnown: false,
    });
  };

  for (const ev of events) {
    if (ev.type === 'user/message') {
      flushAssistant();
      // DSH injects the "Current runtime context …" preamble as a
      // user/message owned by the runtime-context plugin
      // (`data.source.kind === 'plugin'`). It is context, not real user
      // content — rendering it produced a stray "Current runtime context …"
      // bubble under the user's message. Skip plugin/system-owned injections;
      // only keep genuine user-authored text.
      if (isInjectionUserMessage(ev.data)) continue;
      const d = ev.data as {
        content?: Array<{ type?: string; text?: string }>;
      } | undefined;
      const text = (d?.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text) {
        // 通过共享解码函数剥离封套前缀 / JSON——卡片只展示 description
        // (description=用户原始描述，attachment 等附加内容剥离)；intent
        // 用来在渲染端挑出 create-task 卡片。解析失败仍保留原始文本
        // (decodeUserMessage 兜底)，不丢消息。
        const decoded = decodeUserMessage(text);
        if (decoded.intent === 'create-task') {
          turns.push({ type: 'user', text: decoded.description ?? decoded.text, intent: 'create-task' });
        } else {
          turns.push({ type: 'user', text: decoded.text });
        }
      }
    } else if (ev.type === 'assistant/chunk') {
      // 聚合 streaming delta。chunks 只在当前 step 内有效，step 边界
      // （step/end、user turn、tool call）触发下面的 flush。
      // 其他 chunk 类型（block-start、block-end）是记账用的——忽略。
      const d = ev.data as {
        chunk?: { type?: string; text?: string };
      } | undefined;
      const chunk = d?.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        bufText += chunk.text;
      } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        bufReasoning += chunk.text;
      }
      // 其他 chunk 类型（block-start、block-end）是记账用的——忽略。
    } else if (ev.type === 'assistant/message') {
      // chunks 没填进 buffer 时（极短回复直接落 final 事件，没流过）回退到
      // message 自身的 content block。两者都在时 chunks 优先——final 事件的
      // text 是空的，即使 chunks 带了答案。
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
      // tool call 会打断 assistant 的文本——把已累积的部分 flush 后再
      // 输出 tool turn。
      flushAssistant();
      const d = ev.data as { callId?: unknown; name?: string; arguments?: string } | undefined;
      const rawCallId = d?.callId != null ? String(d.callId) : '';
      // tool/call with no callId (corrupt / partial log) is still surfaced
      // as a tool turn — synthesis is better than dropping the call on
      // the floor, but we mark it as `missing-call` so the renderer knows
      // to show "工具调用信息缺失" + "未记录输入". Same treatment as an
      // orphan tool/result so the historical view stays resilient.
      const callId = rawCallId !== '' ? rawCallId : `orphan-${orphanSynthCounter++}`;
      const result = pendingResults.get(callId);
      if (result) {
        const state = classifyResult(result.ok, result.data, result.error);
        turns.push({
          type: 'tool',
          callId,
          name: d?.name ?? '',
          args: d?.arguments,
          ok: result.ok,
          data: result.data,
          presentationMeta: result.presentationMeta,
          error: state === 'stopped' ? undefined : result.error,
          state,
          argsKnown: true,
        });
        pendingResults.delete(callId);
      } else {
        // tool/call with NO matching tool/result — `missing-result` is NOT
        // an automatic failure (the renderer treats it as "结果未记录" with
        // a neutral pill, not a red dot). Only `error` / `stopped` indicate
        // execution went wrong. For the no-callId path above we ALSO emit
        // a tool turn (instead of dropping) but with state='missing-call'
        // since we don't even know whether a result would have matched.
        if (rawCallId === '') {
          turns.push({
            type: 'tool',
            callId,
            name: d?.name ?? '',
            args: d?.arguments,
            ok: false,
            data: undefined,
            presentationMeta: undefined,
            error: undefined,
            state: 'missing-call',
            argsKnown: true,
          });
        } else {
          turns.push({
            type: 'tool',
            callId,
            name: d?.name ?? '',
            args: d?.arguments,
            ok: false,
            data: undefined,
            presentationMeta: undefined,
            error: undefined,
            state: 'missing-result',
            argsKnown: true,
          });
        }
      }
    }
    // 其他事件（已处理的 chunks、结构性 start 事件、session/end-seed、
    // request/*）刻意跳过。
  }

  // Drain orphan results — tool/result events whose callId never matched
  // any tool/call in the log (rare; defensive). Emit them with
  // `state='missing-call'` and `argsKnown=false` so the renderer can
  // surface "未记录输入" and the title fallback "工具调用信息缺失".
  for (const orphan of orphanResults) {
    emitOrphan(orphan);
  }

  // Drain straggler tool/results — buffered in pass 1 whose matching
  // tool/call never arrived. The renderer needs to render them as orphans
  // rather than silently dropping them. This branch is rare (result-only
  // without any matching call) and is what makes the historical view
  // resilient to partial logs.
  for (const [strayCallId, result] of pendingResults.entries()) {
    flushAssistant();
    const resultState = classifyResult(result.ok, result.data, result.error);
    turns.push({
      type: 'tool',
      callId: `orphan-${orphanSynthCounter++}-${strayCallId}`,
      name: '',
      args: undefined,
      ok: result.ok,
      data: result.data,
      presentationMeta: result.presentationMeta,
      // `missing-call` regardless of result ok-ness — the call is missing.
      // `ok` and `error` still carry the result's truth so the row's
      // status dot is honest about what we know happened.
      error: resultState === 'stopped' ? undefined : result.error,
      state: 'missing-call',
      argsKnown: false,
    });
  }

  // 末尾 flush——日志中途结束、没显式边界时也要把累积的内容吐出来。
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

  // DSH 的 output.render(args, value) 决定工具结果中"模型看得到"的内容。
  // 返回占位 token（如 '[todo.list]'）会把真实数据藏起来，模型就可能瞎编
  // （说列表为空、捏造新建 todo 的 id）。这里直接 JSON.stringify 真实结果，
  // 让模型基于真实数据作答。
  //
  // L5-A: output.presentationMeta 由 runtime 在 tool/result 事件上自动调用，
  // 把 raw value 投影成 JsonValue 并附在事件 meta 字段上。我们这里 pass-through
  // (返回 value 不变)，让 DSH 原生消费者（未来的 ToolRow drop-in）能拿到
  // 完整的原始结果数据。render 仍然 JSON.stringify 给模型看。
  const renderJson = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: value === undefined ? '(no result)' : JSON.stringify(value, null, 2) },
  ];
  const jsonOutput = {
    schema: { type: 'json' },
    render: renderJson,
    presentationMeta: (_args: unknown, value: unknown): unknown => value,
  };

  // L5-A: 工具级 presentCall/presentResult helper。每个 defineTool 加
  // `...wire('tool.name')` 即可声明——DSH web frontend 的 drop-in 组件
  // (ToolRow 等) 会按名调用这两函数。我们本地渲染路径暂由渲染端的
  // presentToolResult (来自 shared/tool-presentation) 完成，但把这两个
  // 方法声明在工具上让协议对齐 DSH，将来接 ToolRow 时不用改 wire 形状。
  const wire = (name: string) => ({
    presentCall: (args: unknown) => presentToolCall(name, args),
    presentResult: (args: unknown, result: { isError: boolean; meta?: unknown }) =>
      presentToolResult(name, args, result.meta, !result.isError),
  });

  // ---------------------------------------------------------------------------
  // todo.* — 对 TODO 表的 CRUD。工具参数尽量覆盖 TodoCreate / TodoPatch 全字段，
  // 让 AI 能按 tag / due date 归档，而不仅是 title + status。todo.list
  // 的过滤集也跟前端 TodoFilter 类型对齐，能直接回答"本周到期"之类的问题，
  // 不用把全表拉回来再二次过滤。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'todo.list',
    ...wire('todo.list'),
    description: 'List TODO items, optionally filtered. Every field is optional; omit all of them to return every todo. The model may pass status/priority/tag as a single string or a JSON array. "all" / unknown values for status/priority mean no filter.',
    parameters: {
      status: { type: 'string', description: 'Filter by status: next | doing | done | cancelled | blocked (or comma-separated)' },
      priority: { type: 'string', description: 'Filter by priority: none | low | medium | high (or comma-separated)' },
      tag: { type: 'string', description: 'Filter by a single tag (matches tasks tagged with this string)' },
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
    async execute(args: { status?: string; priority?: string; tag?: string; dueBefore?: number; dueAfter?: number; search?: string; parentId?: string; archivedOnly?: boolean; includeArchived?: boolean; deletedOnly?: boolean; limit?: number }) {
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
    ...wire('todo.get'),
    description: 'Get a single TODO by id. Returns null if the id is unknown.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id (ULID)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return repo.get(args.id as never); },
  }));

  reg(defineTool({
    name: 'todo.create',
    ...wire('todo.create'),
    description: 'Create a real TODO and return it with its generated id. Use a concise actionable title. Defaults are status=next and priority=none; do not invent urgency, due dates, tags, or parent ids. parentId must come from an actual todo.list/todo.search result. Set plannedFor only when the user explicitly asks to do/add it today; a due date of today alone is not enough. Markdown body starts empty — use content.writeBody only when the user supplied meaningful notes.',
    parameters: {
      title: { type: 'string', required: true, description: 'TODO title (required)' },
      status: { type: 'string', description: 'next | doing | done | cancelled | blocked (default next)' },
      priority: { type: 'string', description: 'none | low | medium | high (default none)' },
      dueAt: { type: 'number', description: 'Due date as unix ms; null/omitted means no due date' },
      tags: { type: 'string', description: 'JSON array of tag strings (e.g. \'["urgent","design"]\')' },
      parentId: { type: 'string', description: 'Parent TODO id to create as a subtask; null/omitted means top-level. Use subtasks.list on the parent to see existing children before adding more. Cycles are rejected — you cannot nest a task under one of its own descendants.' },
      plannedFor: { type: 'string', description: 'Stamp the task for the today view. Pass today\'s local date as \'YYYY-MM-DD\' (e.g. compute via `new Date().toLocaleDateString(\'en-CA\')`). Omit/null to leave unplanned. Only set when the user explicitly asks for it.' },
    },
    output: jsonOutput,
    async execute(args: { title: string; status?: string; priority?: string; dueAt?: number; tags?: string; parentId?: string; plannedFor?: string | null }) {
      const input: TodoCreate = { title: args.title };
      if (args.status && (TODO_STATUSES as readonly string[]).includes(args.status)) input.status = args.status as TodoStatus;
      if (args.priority && (PRIORITIES as readonly string[]).includes(args.priority)) input.priority = args.priority as Priority;
      if (args.dueAt != null) input.dueAt = args.dueAt;
      if (args.tags) {
        try {
          const parsed = JSON.parse(args.tags);
          if (Array.isArray(parsed)) input.tags = parsed.filter((s): s is string => typeof s === 'string');
        } catch { /* swallow malformed tag list */ }
      }
      if (args.parentId !== undefined) input.parentId = args.parentId || null;
      if (args.plannedFor !== undefined) input.plannedFor = args.plannedFor;
      const todo = repo.create(input);
      md.writeBody(todo.id as never, '');
      return repo.get(todo.id as never);
    },
  }));

  reg(defineTool({
    name: 'todo.update',
    ...wire('todo.update'),
    description: 'Update fields of an existing TODO. Pass only the fields you want to change — null clears the field (e.g. dueAt: null). Setting status="done" automatically stamps doneAt; any other status clears it. Pass parentId to reparent a task (make it a subtask of another); pass parentId=null to promote to top-level. Cycles are rejected. Pass archivedAt to archive (a unix-ms timestamp, e.g. Date.now()) or archivedAt=null to restore an archived task.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      title: { type: 'string' },
      status: { type: 'string', description: 'next | doing | done | cancelled | blocked' },
      priority: { type: 'string', description: 'none | low | medium | high' },
      dueAt: { type: 'number', description: 'Due date as unix ms; null clears' },
      tags: { type: 'string', description: 'JSON array of tag strings; replaces the existing tag set' },
      parentId: { type: 'string', description: 'Parent TODO id to reparent under; null/empty string promotes to top-level.' },
      archivedAt: { type: 'number', description: 'Archive (unix ms, e.g. Date.now()) or restore (null) a task. Archived tasks leave the active list but stay in the 归档 bin.' },
    },
    output: jsonOutput,
    async execute(args: { id: string; title?: string; status?: string; priority?: string; dueAt?: number; tags?: string; parentId?: string; archivedAt?: number | null }) {
      const { id, tags, ...rest } = args;
      const patch: TodoPatch = {};
      if (rest.title !== undefined) patch.title = rest.title;
      if (rest.status && (TODO_STATUSES as readonly string[]).includes(rest.status)) patch.status = rest.status as TodoStatus;
      if (rest.priority && (PRIORITIES as readonly string[]).includes(rest.priority)) patch.priority = rest.priority as Priority;
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
    ...wire('subtasks.list'),
    description: 'List the direct subtasks of a TODO (parentId == id). Returns [] if the task has no subtasks or does not exist. Use this to inspect a parent\'s children before reparenting or to summarise "the work broken out under this task".',
    parameters: { parentId: { type: 'string', required: true, description: 'Parent TODO id' } },
    output: jsonOutput,
    async execute(args: { parentId: string }) {
      return repo.list({ parentId: args.parentId } as never);
    },
  }));

  reg(defineTool({
    name: 'todo.planForToday',
    ...wire('todo.planForToday'),
    description: 'Stamp an existing TODO for the today view. Pass todayKey = today\'s local date as \'YYYY-MM-DD\' (e.g. compute via `new Date().toLocaleDateString(\'en-CA\')` — the same value the renderer reads back when matching the upper section). Yesterday\'s stamp naturally drops off tomorrow morning without any sweep. Only call when the user EXPLICITLY says "今天做 X" / "加到今天" / "把 X 加到今日"; do not bulk-stamp. Returns the updated TODO. No-op (returns the existing row) when the task is already planned for that day.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id to stamp for today' },
      todayKey: { type: 'string', required: true, description: 'Today\'s local date \'YYYY-MM-DD\'. Must match the renderer\'s equality check exactly.' },
    },
    output: jsonOutput,
    async execute(args: { id: string; todayKey: string }) {
      if (typeof args.todayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.todayKey)) {
        throw new Error('todo.planForToday: todayKey must be a string \'YYYY-MM-DD\'');
      }
      return repo.update(args.id, { plannedFor: args.todayKey });
    },
  }));

  reg(defineTool({
    name: 'todo.unplan',
    ...wire('todo.unplan'),
    description: 'Remove an existing TODO from the today view (clears plannedFor). Idempotent: no-op when the task was not planned. Returns the updated TODO.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to remove from today\'s plan' } },
    output: jsonOutput,
    async execute(args: { id: string }) {
      return repo.update(args.id, { plannedFor: null });
    },
  }));

  reg(defineTool({
    name: 'todo.delete',
    ...wire('todo.delete'),
    description: 'Soft-delete a TODO and its entire subtree. This is a LOGICAL delete — the row, markdown body, and drawings survive so the action is always undoable via todo.restore. The task disappears from every active view (list, search, stats) and is only visible via todo.list with deletedOnly=true. No confirmation needed beyond the normal permission tier.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to soft-delete (cascades to its subtasks)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { repo.delete(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'todo.restore',
    ...wire('todo.restore'),
    description: 'Restore a soft-deleted TODO and its entire subtree — the inverse of todo.delete. Clears deleted_at on the task + every descendant so the whole branch returns to the active list. Safe to call on an already-live task (no-op).',
    parameters: { id: { type: 'string', required: true, description: 'TODO id to restore (clears deleted_at on its subtree)' } },
    output: jsonOutput,
    async execute(args: { id: string }) { repo.restore(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'todo.batchUpdate',
    ...wire('todo.batchUpdate'),
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
    ...wire('todo.search'),
    description: 'Full-text search across TODO titles and markdown bodies (FTS5-backed). Returns hits with a short snippet + score.',
    parameters: { query: { type: 'string', required: true, description: 'Search query' }, limit: { type: 'number', description: 'Max hits (default 20)' } },
    output: jsonOutput,
    async execute(args: { query: string; limit?: number }) { return repo.search(args.query, args.limit ?? 20); },
  }));

  reg(defineTool({
    name: 'todo.stats',
    ...wire('todo.stats'),
    description: 'Aggregate stats: counts by status, 7-day completion rate, average done latency. Useful as a preflight before summarising the user\'s workload.',
    parameters: { windowDays: { type: 'number', description: 'Window for completion stats (default 7)' } },
    output: jsonOutput,
    async execute(args: { windowDays?: number }) { return repo.stats(args.windowDays ?? 7); },
  }));

  // ---------------------------------------------------------------------------
  // content.* — TODO 的 Markdown 正文。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'content.readBody',
    ...wire('content.readBody'),
    description: 'Read the markdown body of a TODO (current version). Returns markdown text + the version number.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.readBody(args.id as never); },
  }));

  reg(defineTool({
    name: 'content.writeBody',
    ...wire('content.writeBody'),
    description: 'Write/replace the markdown body of a TODO. Creates a new version (old version preserved for content.history). For long drafts, write the full body each time — partial updates are not supported.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      markdown: { type: 'string', required: true, description: 'New markdown content' },
    },
    output: jsonOutput,
    async execute(args: { id: string; markdown: string }) {
      // L5-A: snapshot the previous body so the renderer-side presentToolResult
      // can build a real red/green diff (DiffBlock collapses to "all +" if
      // oldText is null). readBody is best-effort — a missing/empty file
      // yields '' and still produces a valid diff against the new content.
      let oldText = '';
      try {
        oldText = md.readBody(args.id as never).markdown ?? '';
      } catch {
        /* first write, or file unreadable — diff against empty */
      }
      const res = md.writeBody(args.id as never, args.markdown);
      return { ...res, __oldText: oldText };
    },
  }));

  reg(defineTool({
    name: 'content.history',
    ...wire('content.history'),
    description: 'List saved markdown versions for a TODO, oldest to newest. Each entry has an id (version number), savedAt, and the body. Use content.restoreVersion to roll back.',
    parameters: { id: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return md.history(args.id as never); },
  }));

  reg(defineTool({
    name: 'content.restoreVersion',
    ...wire('content.restoreVersion'),
    description: 'Restore a previous markdown version. The current version is preserved as a new version before the restore (so undo via content.history + restoreVersion is always possible). Destructive in the sense that it overwrites current body — confirm with the user first.',
    parameters: {
      id: { type: 'string', required: true, description: 'TODO id' },
      versionId: { type: 'number', required: true, description: 'Version number to restore (from content.history)' },
    },
    output: jsonOutput,
    async execute(args: { id: string; versionId: number }) { md.restoreVersion(args.id as never, args.versionId); return { ok: true }; },
  }));

  // ---------------------------------------------------------------------------
  // drawing.* — TODO 上挂的 Excalidraw 场景。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'drawing.list',
    ...wire('drawing.list'),
    description: 'List Excalidraw drawings attached to a TODO. Returns metadata (id, title, thumb path, timestamps). Use drawing.read to get the scene JSON.',
    parameters: { todoId: { type: 'string', required: true, description: 'TODO id' } },
    output: jsonOutput,
    async execute(args: { todoId: string }) { return drawings.list(args.todoId as never); },
  }));

  reg(defineTool({
    name: 'drawing.read',
    ...wire('drawing.read'),
    description: 'Read an Excalidraw drawing scene by id. Returns the full scene JSON (elements, appState). Throws if the id is unknown or the scene file is missing on disk.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return drawings.read(args.id as never); },
  }));

  reg(defineTool({
    name: 'drawing.save',
    ...wire('drawing.save'),
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
    ...wire('drawing.delete'),
    description: 'Permanently delete a drawing. Destructive — confirm with the user first.',
    parameters: { id: { type: 'string', required: true, description: 'Drawing id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { drawings.delete(args.id as never); return { ok: true }; },
  }));

  reg(defineTool({
    name: 'drawing.setThumb',
    ...wire('drawing.setThumb'),
    description: 'Set the thumbnail image for a drawing (a data: URL, typically captured from the canvas). The renderer uses this to show a preview chip in the drawing list. Not destructive.',
    parameters: {
      id: { type: 'string', required: true, description: 'Drawing id' },
      dataUrl: { type: 'string', required: true, description: 'data: URL of the thumbnail image (e.g. data:image/png;base64,...)' },
    },
    output: jsonOutput,
    async execute(args: { id: string; dataUrl: string }) { drawings.setThumb(args.id as never, args.dataUrl); return { ok: true }; },
  }));

  // ---------------------------------------------------------------------------
  // inbox.* — 把磁盘文件（filePath）或粘贴图片（data: URL）挂到 TODO。
  // 对应 main/index.ts 的 inbox.attach / inbox.attachBlob IPC。常用于
  // "把这个文件挂到这个 todo"、"把这张截图加到 bug"。文件通常已经在磁盘上
  // （截图 / 剪贴板图片保存路径），或者以 data: URL 的形式传来。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'inbox.attach',
    ...wire('inbox.attach'),
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
    ...wire('inbox.attachBlob'),
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
  // conversation.* — 管理 AI 自己的会话。
  //
  // 大多数情况下 AI 的 ai.ask 都跑在用户当前所在的会话上（runtime 会隐式
  // 带上），但偶尔 AI 需要开副线程（"让我在草稿线程里捋一下"）、找历史会话
  // （"上次的设计评审我们叫什么"）、或者归档已完成的会话。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'conversation.list',
    ...wire('conversation.list'),
    description: 'List AI conversations. By default archived threads are hidden. Each row includes the title, timestamps, and an archived flag. Use conversation.history to load the turns of a specific conversation.',
    parameters: { includeArchived: { type: 'boolean', description: 'Include archived conversations (default false)' } },
    output: jsonOutput,
    async execute(args: { includeArchived?: boolean }) { return { conversations: conversations.list(args.includeArchived ?? false) }; },
  }));

  reg(defineTool({
    name: 'conversation.create',
    ...wire('conversation.create'),
    description: 'Create a new (empty) AI conversation. Returns the new conversation row (id, title, timestamps). The default title is "新对话 <timestamp>" — the DSH session-title service will replace it with an AI-generated title after the first turn, or the user can rename it via the UI.',
    parameters: { title: { type: 'string', description: 'Optional explicit title; omit to use the default new-conversation title' } },
    output: jsonOutput,
    async execute(args: { title?: string }) { return { conversation: conversations.create(args.title ? { title: args.title } : undefined) }; },
  }));

  reg(defineTool({
    name: 'conversation.rename',
    ...wire('conversation.rename'),
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
    ...wire('conversation.archive'),
    description: 'Archive an AI conversation (soft delete). Hidden from the default list. Reversible via conversation.unarchive. The on-disk JSONL log is NOT touched.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.archive(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.unarchive',
    ...wire('conversation.unarchive'),
    description: 'Restore an archived conversation so it shows in the default list again.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.unarchive(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.delete',
    ...wire('conversation.delete'),
    description: 'Hard delete the DB row of an AI conversation. The on-disk JSONL event log is NOT cleaned up by this (out of scope). Prefer conversation.archive for "I\'m done with this thread" semantics.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) { return { ok: conversations.delete(args.id) }; },
  }));

  reg(defineTool({
    name: 'conversation.history',
    ...wire('conversation.history'),
    description: 'Load the persisted turn history of a conversation. Returns the same shape the AIPane uses: { type: "user" | "assistant" | "tool", text?, reasoning?, name?, args?, ok?, data?, error? }. Use this to "remember" what a past conversation discussed.',
    parameters: { id: { type: 'string', required: true, description: 'Conversation id' } },
    output: jsonOutput,
    async execute(args: { id: string }) {
      // L4-H: 历史加载由 runtime 持有（dsh-session-persistence-jsonl 后端）。
      // 工具调用点拿不到直接句柄——未来可以暴露 runtime.loadHistory()。
      // 这里返回空数组 + 提示：让模型知道要"回忆"哪个会话时，请用户去
      // AIPane 切到那条线。提前引用 args.id，保证未来按它计算键的实装
      // 有非 undefined 的锚点。
      void args.id;
      return {
        turns: [],
        note: 'conversation.history at the tool layer is a stub; the AIPane UI loads the full history for the user when they switch threads. If you need to recall a past conversation, ask the user to open it.',
      };
    },
  }));

  // ---------------------------------------------------------------------------
  // ai.* — 自我探查：检查连通性、发现可用模型、读累计花费。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'ai.health',
    ...wire('ai.health'),
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
    ...wire('ai.models'),
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
    ...wire('ai.stats'),
    description: 'Read the cumulative AI cost from settings (sum of every successful turn\'s costUsd). Useful when the user asks "how much have you spent this month?"',
    parameters: {},
    output: jsonOutput,
    async execute() {
      const s = settings.get();
      return { monthlyCostUsd: s.monthlyCostUsd, lastHeartbeatAt: s.lastHeartbeatAt };
    },
  }));

  // ---------------------------------------------------------------------------
  // app.currentContext — "用户现在看的是什么"。
  //
  // renderer 通过 app.focus.set 把当前聚焦的实体（task / document / drawing）
  // 推到 main，这个工具读取那个指针并补全数据，让模型能基于真实信息作答——
  // 比如"重写我正在看的这个任务的进展文档"需要 task id + doc id，本工具一
  // 次性返回。
  //
  // 当没有聚焦时返回 null——别回退到"猜最近的任务"，那样会编造上下文、
  // 把编辑偷偷张冠李戴。如果返回 null，让用户说想做什么，或调 todo.list
  // 找候选。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'app.currentContext',
    ...wire('app.currentContext'),
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
  // ask_user_approval — 模型侧的 HITL 原语。
  //
  // 注意：ask_user_question 不在这里注册——它属于 @deepseek-ai/dsh-tool-ask-user
  // （cordis.yml 装载），走 ctx.userQuestions.ask()。如果这里也注册一份，DSH
  // 启动会报 "tool 'ask_user_question' is already registered"，切换会话会
  // 每次都撞一次。
  //
  // ask_user_approval 是我们自己的：DSH 没内建审批工具，这里注册并通过
  // 'approval/request' waterfall 桥接（bootDsh 里装的监听器把请求转发到
  // renderer，UserApprovalCard 渲染审批卡）。
  //
  // 90 秒超时：用户没答则 reject，agent 循环继续。
  // ---------------------------------------------------------------------------

  reg(defineTool({
    name: 'ask_user_approval',
    ...wire('ask_user_approval'),
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
