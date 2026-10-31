import { expect } from '@playwright/test';
import type { AppHandle } from './helpers';

/** Observe normal renderer acknowledgements without mocking engine execution or persistence. */
export async function installDrawingAckRecorder(handle: AppHandle) {
  await handle.app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('__todo_router__');
    (globalThis as any).__nativeActionAcks = {};
    ipcMain.removeHandler('__todo_router__');
    ipcMain.handle('__todo_router__', (event, channel, request) => {
      if (channel === 'drawing.contextResult' || channel === 'drawing.engineResult') (globalThis as any).__nativeActionAcks[request.opId] = request;
      return original(event, channel, request);
    });
  });
}
export async function drawingBridge(handle: AppHandle, event: string, payload: any, timeout = 10000): Promise<any> {
  await handle.app.evaluate(({ BrowserWindow }, { event, payload }) => {
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('#/compact'))!.webContents.send(event, payload);
  }, { event, payload });
  await expect.poll(() => handle.app.evaluate((_electron, id) => !!(globalThis as any).__nativeActionAcks[id], payload.opId), { timeout }).toBe(true);
  return handle.app.evaluate((_electron, id) => { const value = (globalThis as any).__nativeActionAcks[id]; delete (globalThis as any).__nativeActionAcks[id]; return value; }, payload.opId);
}
