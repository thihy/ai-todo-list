// 画布握手与 apply 派发（B 版「让用户看着 AI 画」）。
//
// 为什么要这一层：Excalidraw 的官方转换函数 convertToExcalidrawElements
// 只能在**渲染进程**跑 —— @excalidraw/excalidraw 的运行时入口是浏览器
// bundle，main 里 import 直接失败（roughjs 解析不了）。而 DSH 工具全部在
// main。所以「算骨架」在 main，「转换 + 应用」必须回到渲染进程。
//
// 于是需要一个跨进程的请求/应答：main 发 apply，等渲染进程回执，超时兜底。
// 这个模块只管编排，不碰 Electron —— 窗口广播和 IPC 注册都由调用方注入，
// 这样它能直接单测，不用起 Electron。
//
// 生命周期：
//   渲染进程挂载画布 → canvasReady(drawingId) → 登记进 live set
//   main 调 applyToCanvas() → 若画布不在 live set，先要求导航并等待就绪
//                            → 发 apply → 等 applied 回执 → 返回结果
//   渲染进程卸载画布 → canvasGone(drawingId) → 从 live set 移除

import { randomUUID } from 'node:crypto';
import type {
  DrawingApplyPayload,
  DrawingAppliedPayload,
  DrawingCanvasReadyPayload,
  DrawingSkeleton,
} from '../../shared/drawing-spec';

/** main → 渲染进程的回调（由 ipc 层注入）。 */
export type ApplySender = (payload: DrawingApplyPayload) => void;
/** 要求 UI 打开某张绘图（由 ipc 层注入，通常是 app:navigate）。 */
export type NavigateToDrawing = (todoId: string, drawingId: string) => void;

export interface DrawingCanvasHostOptions {
  send: ApplySender;
  navigate: NavigateToDrawing;
  /** 画布从「未就绪」到「就绪」的最长等待，默认 6s。
   *  覆盖的是「打开 tab → React 挂载 → 动态 import excalidraw → 拿到 API」
   *  这条链，6s 在冷启动机器上留了余量。 */
  readyTimeoutMs?: number;
  /** apply 发出后等回执的最长等待，默认 6s。 */
  ackTimeoutMs?: number;
  /** 日志出口，避免这个纯编排模块直接依赖 logger。 */
  log?: (msg: string) => void;
}

export interface ApplyOutcome {
  ok: boolean;
  /** 失败原因（模型读得懂的中文）。 */
  error?: string;
  /** 是否真的把元素加上去了。超时时为 false。 */
  applied: boolean;
}

export class DrawingCanvasHost {
  private readonly live = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly inflight = new Map<
    string,
    (payload: DrawingAppliedPayload) => void
  >();
  private readonly opts: Required<Omit<DrawingCanvasHostOptions, 'log'>> & {
    log: (msg: string) => void;
  };

  constructor(options: DrawingCanvasHostOptions) {
    this.opts = {
      send: options.send,
      navigate: options.navigate,
      readyTimeoutMs: options.readyTimeoutMs ?? 6_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 6_000,
      log: options.log ?? (() => undefined),
    };
  }

  /** 当前有多少张画布挂着 —— 单测和诊断用。 */
  get liveCount(): number {
    return this.live.size;
  }

  isLive(drawingId: string): boolean {
    return this.live.has(drawingId);
  }

  /** 渲染进程报告画布就绪。 */
  canvasReady(payload: DrawingCanvasReadyPayload): void {
    const { drawingId } = payload;
    this.live.add(drawingId);
    this.opts.log(`drawing canvas ready: ${drawingId} (live=${this.live.size})`);
    // 唤醒所有等这张画布的请求 —— 可能有多个工具调用在排队。
    const pending = this.waiters.get(drawingId);
    if (pending) {
      this.waiters.delete(drawingId);
      for (const resolve of pending) resolve();
    }
  }

  /** 渲染进程报告画布卸载。 */
  canvasGone(drawingId: string): void {
    if (this.live.delete(drawingId)) {
      this.opts.log(`drawing canvas gone: ${drawingId} (live=${this.live.size})`);
    }
  }

  /** 渲染进程回执 apply 结果。 */
  applied(payload: DrawingAppliedPayload): void {
    const settle = this.inflight.get(payload.opId);
    if (!settle) {
      // 迟到的回执（超时之后才到）。丢掉即可 —— 那一轮的 Promise 已经
      // 以超时拒绝了，再 resolve 也不会有人接。
      this.opts.log(`drawing apply ack for unknown op ${payload.opId} (dropped)`);
      return;
    }
    this.inflight.delete(payload.opId);
    settle(payload);
  }

  /**
   * 把一批骨架应用到指定画布：必要时自动打开该绘图的 tab，等画布就绪后
   * 下发 apply，最后等回执。**永不抛异常** —— 失败以 `{ok:false}` 返回，
   * 由调用方转成模型读得懂的提示。
   */
  async applyToCanvas(opts: {
    todoId: string;
    drawingId: string;
    skeletons: DrawingSkeleton[];
    /** 新建的绘图要滚动到内容；追加到已有绘图则不动视口。 */
    scrollToContent?: boolean;
  }): Promise<ApplyOutcome> {
    const { todoId, drawingId, skeletons, scrollToContent } = opts;
    if (skeletons.length === 0) {
      return { ok: false, applied: false, error: '没有可绘制的元素。' };
    }

    if (!this.live.has(drawingId)) {
      // B 版的重点：不用等用户手动开 tab，直接导航过去。
      this.opts.log(`drawing canvas not live for ${drawingId}; navigating`);
      this.opts.navigate(todoId, drawingId);
      const ready = await this.waitForReady(drawingId);
      if (!ready) {
        return {
          ok: false,
          applied: false,
          error: `打开画布超时（${this.opts.readyTimeoutMs}ms）。请确认应用窗口可见，然后重试。`,
        };
      }
    }

    const opId = randomUUID();
    const ack = new Promise<DrawingAppliedPayload>((resolve) => {
      this.inflight.set(opId, resolve);
    });

    const payload: DrawingApplyPayload = {
      drawingId,
      opId,
      skeletons,
      scrollToContent,
    };
    this.opts.send(payload);

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.opts.ackTimeoutMs),
    );
    const result = await Promise.race([ack, timeout]);

    if (result === 'timeout') {
      this.inflight.delete(opId);
      this.opts.log(`drawing apply timeout for ${drawingId} op=${opId}`);
      return {
        ok: false,
        applied: false,
        error: `画布没有在 ${this.opts.ackTimeoutMs}ms 内确认绘制结果。请重试。`,
      };
    }
    return {
      ok: result.ok,
      applied: result.ok,
      error: result.error,
    };
  }

  /** 等某张画布就绪，带超时。resolve(true/false)。 */
  private waitForReady(drawingId: string): Promise<boolean> {
    if (this.live.has(drawingId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        const list = this.waiters.get(drawingId);
        if (list) {
          const idx = list.indexOf(waiter);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(drawingId);
        }
        resolve(ok);
      };
      const waiter = (): void => finish(true);
      const list = this.waiters.get(drawingId);
      if (list) list.push(waiter);
      else this.waiters.set(drawingId, [waiter]);
      setTimeout(() => {
        if (!this.live.has(drawingId)) finish(false);
      }, this.opts.readyTimeoutMs);
    });
  }
}