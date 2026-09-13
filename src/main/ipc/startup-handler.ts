// 启动状态 IPC handler —— 仅注册 `app.startup.get` 一个 invoke 通道。
// 实时更新通过 `app:startup` 事件推送(在 startup-state.ts 内部直
// 接调用 BrowserWindow.webContents.send)。

import { okResult } from './router';
import { register } from './router';
import { startupState } from '../startup-state';

export function registerStartupHandler(): void {
  register('app.startup.get', () => {
    return okResult(startupState.snapshot());
  });
}