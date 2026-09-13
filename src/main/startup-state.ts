// 启动状态总线 —— 维护 core / ai 两组独立状态,以及可读的当前阶段、
// 可恢复错误。Core 表示「任务管理数据已可用」(DB 已打开、文件存储
// 就绪、IPC 路由就绪、首批迁移完成),AI 表示「DSH runtime + AI IPC
// 已注册」。渲染端通过 IPC 查询当前快照 + 订阅变化事件。
//
// 设计要点：
// - 阶段编号仅用于日志 / 调试,不在 IPC 表面泄漏。
// - 错误信息以人话为主,绝不回显原始堆栈、密钥、数据目录绝对路径。
// - 状态变化通过 `core:changed` / `ai:changed` 事件经 `app:startup`
//   推送;首次订阅 + 立即读取快照,避免错过已发生的就绪事件。
// - 启动窗口显示由 core 决定,不等待 ai;DSH 失败不影响任务管理。

import { BrowserWindow } from 'electron';
import { logger } from './logger';

export type StartupPhase =
  | 'boot'           // 进程已 fork,whenReady 尚未到达
  | 'settings'       // 设置 store 读取
  | 'data-dir'       // 数据目录创建
  | 'db-open'        // 数据库打开 + 迁移
  | 'file-stores'    // markdown / drawing / document / inbox stores 构造
  | 'ipc'            // 业务 IPC handler 注册
  | 'window'         // 主窗口创建
  | 'core-ready'     // 核心数据可读 (=> core: ready)
  | 'ai-loading'     // AI runtime / DSH container 加载中
  | 'ai-ready'       // AI handlers 已注册 (=> ai: ready)
  | 'ai-failed';     // AI 初始化失败 (=> ai: failed,但 core 不变)

export type ComponentStatus = 'pending' | 'loading' | 'ready' | 'failed';

export interface ComponentState {
  status: ComponentStatus;
  /** 单一可读阶段名,渲染端展示用。 */
  phase: StartupPhase;
  /** 阶段开始时间(进程内 epoch ms)。 */
  startedAt: number;
  /** 进入当前 status 的时间,用于计算阶段耗时。 */
  statusAt: number;
  /** 人话错误,绝不包含原始堆栈 / 密钥 / 绝对路径。 */
  errorMessage?: string;
}

export interface StartupSnapshot {
  core: ComponentState;
  ai: ComponentState;
  /** 自进程启动到当前的总耗时 ms,渲染端展示「启动时间较长…」用。 */
  elapsedMs: number;
}

type Listener = (snapshot: StartupSnapshot) => void;

class StartupState {
  private core: ComponentState = this.fresh('boot');
  private ai: ComponentState = this.fresh('boot');
  private readonly listeners = new Set<Listener>();
  private readonly processStart = Date.now();
  /** Single-flight guard for `app.startup.retry { component: 'ai' }`. Reset
   *  by `finishAiRetry()` once the boot completes. Stays module-scoped
   *  because the IPC handler closes over the same `startupState` singleton. */
  private aiRetryInFlight = false;

  private fresh(phase: StartupPhase): ComponentState {
    return {
      status: 'pending',
      phase,
      startedAt: Date.now(),
      statusAt: Date.now(),
    };
  }

  /** 推进 core 的阶段。同一阶段再次调用仅刷新时间,不发事件。 */
  setCorePhase(phase: StartupPhase): void {
    const now = Date.now();
    this.core = { ...this.core, phase, startedAt: now };
    this.emit('core');
  }

  markCoreReady(): void {
    const now = Date.now();
    this.core = {
      status: 'ready',
      phase: 'core-ready',
      startedAt: this.core.startedAt,
      statusAt: now,
    };
    logger.info(`startup: core ready in ${now - this.processStart}ms`);
    this.emit('core');
  }

  markCoreFailed(message: string): void {
    const now = Date.now();
    this.core = {
      status: 'failed',
      phase: this.core.phase,
      startedAt: this.core.startedAt,
      statusAt: now,
      errorMessage: redactMessage(message),
    };
    logger.error(`startup: core failed: ${this.core.errorMessage}`);
    this.emit('core');
  }

  setAiPhase(phase: StartupPhase): void {
    const now = Date.now();
    this.ai = { ...this.ai, phase, startedAt: now };
    this.emit('ai');
  }

  markAiReady(): void {
    // STARTUP-DSH-001: `ai.ready` now means "the local DSH runtime is
    // booted" — i.e. Cordis plugins loaded, adapter / tools / persistence
    // registered, listeners installed, the singleton `DshRuntime` object
    // exists. It does NOT mean:
    //   - provider network reachable
    //   - API key valid
    //   - any specific model available
    //   - any user-facing request will succeed
    // Those checks live in `ai.ask`'s per-request path. The renderer
    // splash waits for this transition because it wants the user to
    // not see a blank AI pane on first open, not because every model
    // call will succeed.
    const now = Date.now();
    this.ai = {
      status: 'ready',
      phase: 'ai-ready',
      startedAt: this.ai.startedAt,
      statusAt: now,
    };
    logger.info(`startup: ai ready (local DSH booted) in ${now - this.processStart}ms`);
    this.emit('ai');
  }

  markAiFailed(message: string): void {
    // STARTUP-DSH-001: `ai.failed` now means "the LOCAL DSH boot
    // failed" — cordis.yml missing, plugin tree didn't assemble, a
    // critical ctx service (llm/tools/agents) was absent. It does NOT
    // mean provider / API-key / network failures: those are surfaced
    // by `ai.ask` per request and remain non-fatal to the splash.
    const now = Date.now();
    this.ai = {
      status: 'failed',
      phase: 'ai-failed',
      startedAt: this.ai.startedAt,
      statusAt: now,
      errorMessage: redactMessage(message),
    };
    logger.warn(`startup: ai failed (local DSH boot): ${this.ai.errorMessage}`);
    this.emit('ai');
  }

  /** In-session AI retry entry point. Returns `true` if a retry was
   *  scheduled, `false` if one is already in flight or the AI component is
   *  not in a state that allows a retry.
   *
   *  The actual boot is performed by the caller (src/main/index.ts), which
   *  knows how to wire the runtime deps. This method only owns the
   *  single-flight guard + the loading transition. On completion the
   *  caller must invoke `markAiReady()` or `markAiFailed(reason)`, both
   *  of which emit `app:startup` to the renderer. */
  tryStartAiRetry(): boolean {
    if (this.aiRetryInFlight) return false;
    // Only allow retry from 'failed' (the documented entry state). 'loading'
    // means a boot is already pending; 'ready' means nothing to retry;
    // 'pending' means the boot hasn't happened yet (no-op).
    if (this.ai.status !== 'failed') return false;
    this.aiRetryInFlight = true;
    const now = Date.now();
    this.ai = {
      status: 'loading',
      phase: 'ai-loading',
      startedAt: this.ai.startedAt,
      statusAt: now,
      errorMessage: undefined,
    };
    logger.info(`startup: ai retry requested @ ${now - this.processStart}ms`);
    this.emit('ai');
    return true;
  }

  /** Called by the boot callback (success path) after `tryStartAiRetry`
   *  returned true. Clears the single-flight guard. */
  finishAiRetry(): void {
    this.aiRetryInFlight = false;
  }

  snapshot(): StartupSnapshot {
    return {
      core: this.core,
      ai: this.ai,
      elapsedMs: Date.now() - this.processStart,
    };
  }

  /** 推送给所有 BrowserWindow 的订阅者。
   *  没窗口时(尚未创建)直接返回 —— 不缓存,以免积压。 */
  private emit(_which: 'core' | 'ai'): void {
    const snap = this.snapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('app:startup', snap);
      } catch (err) {
        logger.warn(`startup emit failed: ${(err as Error).message}`);
      }
    }
    for (const l of this.listeners) {
      try { l(snap); } catch (err) {
        logger.warn(`startup listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** 仅 main 进程内订阅(给 startup-handler 等使用)。 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** 过滤掉可能的敏感内容:绝对路径 / 长字符串(疑似密钥 / base64 blob) /
 *  看起来像堆栈的东西,只留下人话和简短原因。 */
function redactMessage(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '未知错误';
  let s = raw.replace(/\s+/g, ' ').trim();
  // 去掉 Windows 绝对路径前缀
  s = s.replace(/[A-Z]:\\[^\s'"]+/gi, '<path>');
  // 去掉类 Unix 绝对路径
  s = s.replace(/\/(?:home|root|Users|var|tmp|etc|opt)\/[^\s'"]+/g, '<path>');
  // 截断过长的(疑似堆栈 / base64)
  if (s.length > 200) s = s.slice(0, 200) + '…';
  return s;
}

export const startupState = new StartupState();