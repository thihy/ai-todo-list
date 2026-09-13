// 启动状态 IPC handler —— 注册两个通道：
//   - `app.startup.get`：快照查询，返回当前 core / ai 状态。
//   - `app.startup.retry { component: 'ai' }`：会话内 AI 重试入口（UX-01）。
//
// 实时更新通过 `app:startup` 事件推送（在 startup-state.ts 内部直接
// 调用 BrowserWindow.webContents.send）。

import { okResult, failResult, register } from './router';
import { startupState } from '../startup-state';
import { logger } from '../logger';

/** UX-01 retry contract — supplied by the caller (`src/main/index.ts`)
 *  because the closure needs access to the runtime deps. The handler
 *  dereferences `retry.retryAi` on every call so a later reassignment of
 *  `retry.retryAi` in `index.ts` takes effect immediately without needing
 *  to re-register the handler. */
export interface StartupRetryHooks {
  retryAi: () => boolean;
}

export interface AppStartupRetryRes {
  accepted: boolean;
  /** 'accepted: true' 表示 main 已经把 ai 切换到 'loading' 状态。
   *  'accepted: false' 表示组件当前不在 'failed' 状态，或已有
   *  重试在飞——调用方应当继续展示当前 ai 状态而不触发新的尝试。 */
  reason?: 'not_failed' | 'already_in_flight';
}

export function registerStartupHandler(retry: StartupRetryHooks): void {
  register('app.startup.get', () => {
    return okResult(startupState.snapshot());
  });

  register('app.startup.retry', (_e, req) => {
    const component = req?.component;
    if (component !== 'ai') {
      return failResult('unsupported_component', `unknown component: ${String(component)}`);
    }
    const aiBefore = startupState.snapshot().ai;
    if (aiBefore.status === 'loading') {
      logger.info('app.startup.retry: rejected (already loading)');
      const res: AppStartupRetryRes = { accepted: false, reason: 'already_in_flight' };
      return okResult(res);
    }
    if (aiBefore.status !== 'failed') {
      logger.info(`app.startup.retry: rejected (ai.status=${aiBefore.status})`);
      const res: AppStartupRetryRes = { accepted: false, reason: 'not_failed' };
      return okResult(res);
    }
    // Hand off to the closure supplied by index.ts (which knows the deps
    // for the boot). The closure calls startupState.tryStartAiRetry() and
    // returns whether the loading transition took effect.
    const accepted = retry.retryAi();
    if (!accepted) {
      // Single-flight race lost between the snapshot above and the call.
      // Treat it identically to already_in_flight.
      const res: AppStartupRetryRes = { accepted: false, reason: 'already_in_flight' };
      return okResult(res);
    }
    const res: AppStartupRetryRes = { accepted: true };
    return okResult(res);
  });
}
