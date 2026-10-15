// AI 绘图（B 版）的跨进程接线。
//
// 职责边界：
//   - 这里只做「窗口广播 + IPC 登记 + 持有 DrawingCanvasHost 单例」。
//   - 排版在 src/main/drawing/layout.ts（纯函数）。
//   - 握手 / 超时 / 并发在 src/main/drawing/canvas-host.ts（纯编排）。
//   - 真正的 Excalidraw 转换在渲染进程 —— @excalidraw/excalidraw 的运行时
//     入口是浏览器 bundle，main 侧 import 会直接失败（roughjs 解析不了）。

import { BrowserWindow } from 'electron';
import { register, okResult, failResult } from './router';
import { logger } from '../logger';
import { DrawingCanvasHost } from '../drawing/canvas-host';
import type { DrawingApplyPayload } from '../../shared/drawing-spec';

/** 进程内单例：DSH 工具和 IPC handler 都要拿到同一个 host，否则
 *  工具发出去的 apply 没人接、渲染进程回的 ack 也没人收。 */
let host: DrawingCanvasHost | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function getDrawingCanvasHost(): DrawingCanvasHost {
  if (!host) {
    host = new DrawingCanvasHost({
      send: (payload: DrawingApplyPayload) => {
        broadcast('app:drawing-apply', payload);
      },
      sendExport: (payload) => broadcast('app:drawing-export', payload),
      // 复用既有的独立绘图路由（App.tsx 的 'todo-drawing' 分支直接挂载
      // ExcalidrawEditor）。走独立路由而不是 DocumentsView 的 tab，是因为
      // 后者的选中 tab 状态在 App 里托管着，从 main 推一个「选中某个绘图
      // tab」的意图过去要跨两层 state，握手窗口更容易丢。
      navigate: (todoId, drawingId) => {
        broadcast('app:navigate', { route: `#/todo/${todoId}/drawing/${drawingId}` });
      },
      log: (msg) => logger.info(`[drawing-canvas] ${msg}`),
    });
  }
  return host;
}

export function registerDrawingCanvasHandlers(): void {
  const h = getDrawingCanvasHost();
  register('drawing.exported', (_e, req) => {
    h.exported(req);
    return Promise.resolve(okResult(undefined as never));
  });

  register('drawing.canvasReady', (_e, req) => {
    try {
      h.canvasReady({ drawingId: req.drawingId });
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('canvas_ready_failed', (err as Error).message));
    }
  });

  register('drawing.canvasGone', (_e, req) => {
    try {
      h.canvasGone(req.drawingId);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('canvas_gone_failed', (err as Error).message));
    }
  });

  register('drawing.applied', (_e, req) => {
    try {
      h.applied({
        opId: req.opId,
        drawingId: req.drawingId,
        ok: req.ok,
        error: req.error,
      });
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('applied_failed', (err as Error).message));
    }
  });

  logger.info('drawing canvas handshake handlers registered');
}
