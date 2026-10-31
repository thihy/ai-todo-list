import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchApp, type AppHandle } from './helpers';
import { DECLARED_NATIVE_ACTIONS, nativeActionGuidance } from '../../src/shared/drawing-native-actions';

async function installAckRecorder(handle: AppHandle) {
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
async function bridge(handle: AppHandle, event: string, payload: any, timeout = 10000): Promise<any> {
  await handle.app.evaluate(({ BrowserWindow }, { event, payload }) => {
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('#/compact'))!.webContents.send(event, payload);
  }, { event, payload });
  await expect.poll(() => handle.app.evaluate((_electron, id) => !!(globalThis as any).__nativeActionAcks[id], payload.opId), { timeout }).toBe(true);
  return handle.app.evaluate((_electron, id) => { const value = (globalThis as any).__nativeActionAcks[id]; delete (globalThis as any).__nativeActionAcks[id]; return value; }, payload.opId);
}

test('every registered Excalidraw native action is exposed and attempted with real engine fixtures', async () => {
  test.setTimeout(240000);
  const fixturePath = resolve('tests/fixtures/native-actions.excalidraw');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const handle = await launchApp();
  const report: any[] = [];
  try {
    await expect(handle.win.locator('.task-list__add-btn')).toBeVisible({ timeout: 30000 });
    await installAckRecorder(handle);
    await handle.app.evaluate(({ BrowserWindow }, dataDir) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.on('will-download', (_event, item) => item.setSavePath(`${dataDir}/native-action-export.excalidraw`));
    }, handle.dataDir);
    await handle.win.evaluate(() => {
      // Isolate the OS boundary, keeping real DOM ClipboardItems/Blobs and real native action code.
      let items: ClipboardItem[] = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        read: async () => items,
        write: async (next: ClipboardItem[]) => { items = next; },
        readText: async () => { const item = items.find(item => item.types.includes('text/plain')); return item ? (await item.getType('text/plain')).text() : ''; },
        writeText: async (text: string) => { items = [new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) })]; },
      } });
    });
    await handle.win.evaluate(raw => {
      const file = new File([raw], 'native-actions.excalidraw', { type: 'application/json' });
      const handle = { kind: 'file', name: file.name, getFile: async () => file,
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        createWritable: async () => ({ write: async (value: unknown) => { (window as any).__nativeExport = value; }, close: async () => {} }) };
      Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async () => [handle] });
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => handle });
    }, JSON.stringify(fixture));
    const ids = await handle.win.evaluate(async fixture => {
      const task = await window.todoList.todo.create({ title: '原生动作完整验收' }); if (!task.ok) throw Error(task.message);
      const drawing = await window.todoList.drawing.save(task.data.id, fixture); if (!drawing.ok) throw Error(drawing.message);
      return { todoId: task.data.id, drawingId: drawing.data.id };
    }, fixture);
    const mount = async (action?: string) => {
      await handle.win.evaluate(id => { location.hash = `/todo/${id}`; }, ids.todoId);
      await expect(handle.win.locator('.excalidraw')).toHaveCount(0);
      const fresh = structuredClone(fixture);
      if (action === 'ungroup') for (const element of fresh.elements) if (['b', 'c'].includes(element.id)) element.groupIds = ['native-group'];
      if (action === 'unlockAllElements') fresh.elements.find((element: any) => element.id === 'c').locked = true;
      if (action === 'autoResize') fresh.elements.find((element: any) => element.id === 'text').autoResize = false;
      await handle.win.evaluate(async ({ ids, fresh }) => {
        const saved = await window.todoList.drawing.save(ids.todoId, fresh, ids.drawingId); if (!saved.ok) throw Error(saved.message);
        location.hash = `/todo/${ids.todoId}/drawing/${ids.drawingId}`;
      }, { ids, fresh });
      await expect(handle.win.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30000 });
      const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
      if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    };
    const context = () => bridge(handle, 'app:drawing-context', { drawingId: ids.drawingId, opId: randomUUID(), includeActions: true });
    const perform = async (action: string, elementIds: string[], value?: unknown) => {
      const latest = await context(); if (!latest.ok) throw Error(latest.error);
      return bridge(handle, 'app:drawing-engine', { drawingId: ids.drawingId, opId: randomUUID(), kind: 'native-action', baseRevision: latest.context.revision, action, elementIds, ...(value !== undefined ? { value } : {}) });
    };
    await mount();
    const inventory = await context(); expect(inventory.ok).toBe(true);
    const actions = inventory.context.nativeActions as Array<{ name: string }>;
    expect(actions.length).toBeGreaterThan(80);
    expect(actions.map(action => action.name).filter(name => !DECLARED_NATIVE_ACTIONS.includes(name))).toEqual([]);
    const filtered = process.env.TODO_NATIVE_ACTION_FILTER?.split(',');
    const attempted = process.env.TODO_NATIVE_ACTION_SUPPLEMENTAL_ONLY === '1' ? [] : actions.filter(action => !filtered || filtered.includes(action.name));
    for (const { name } of attempted) {
      await mount(name);
      let targets = ['a'];
      if (name === 'bindText') targets = ['text', 'b'];
      else if (name === 'cropEditor') targets = ['image'];
      else if (['selectAllElementsInFrame', 'removeAllElementsFromFrame'].includes(name)) targets = ['frame'];
      else if (name === 'toggleLinearEditor' || name.startsWith('changeArrow')) targets = ['edge'];
      else if (['changeFontFamily', 'changeFontSize', 'changeTextAlign', 'increaseFontSize', 'decreaseFontSize', 'wrapTextInContainer', 'autoResize', 'copyText'].includes(name)) targets = ['text'];
      else if (name.startsWith('align') || name.startsWith('distribute') || ['group', 'ungroup', 'wrapSelectionInFrame'].includes(name)) targets = ['b', 'c', 'text'];
      if (name === 'ungroup') targets = ['b', 'c'];
      if (name === 'unlockAllElements') targets = [];
      if (name === 'pasteStyles' || name === 'paste') { await perform(name === 'paste' ? 'copy' : 'copyStyles', ['a']); targets = ['b']; }
      if (name === 'undo' || name === 'redo') { await perform('changeOpacity', ['a'], 40); if (name === 'redo') await perform('undo', ['a']); }
      if (name === 'saveToActiveFile') await perform('loadScene', []);
      const value = nativeActionGuidance(name).value.example;
      const result = await perform(name, targets, value);
      const actual = await context();
      report.push({ name, targets, result, actualSelection: actual.context?.selectedElementIds,
        targetState: actual.context?.elements.filter((element: any) => targets.includes(element.id)).map((element: any) => ({ id: element.id, type: element.type, boundElements: element.boundElements, autoResize: element.autoResize, locked: element.locked })) });
      await handle.app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.isFullScreen()) window.setFullScreen(false); });
    }
    const registered = new Set(actions.map(action => action.name));
    const supplemental: any[] = [];
    if (!filtered) {
      await mount();
      expect(await perform('copyAsPng', ['a'])).toMatchObject({ ok: true });
      const pasted = await perform('paste', []);
      const persisted = await handle.win.evaluate(id => window.todoList.drawing.read(id), ids.drawingId);
      expect(pasted, JSON.stringify(pasted)).toMatchObject({ ok: true, durable: true, liveChanged: true });
      expect(persisted.ok).toBe(true);
      const image = (persisted as any).data.elements.find((element: any) => element.type === 'image' && element.id !== 'image');
      // Excalidraw keeps standalone images' collaboration-upload marker pending.
      // Durable local completion is the actual binary file plus initialized dimensions.
      expect(image).toMatchObject({ fileId: expect.any(String) });
      expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
      expect((persisted as any).data.files[image.fileId].dataURL).toMatch(/^data:image\//);
      supplemental.push({ name: 'paste-image', result: pasted, imagePersisted: true });
      await mount();
      await handle.win.evaluate(() => {
        const clip = navigator.clipboard as any;
        (window as any).__nativeClipboardMethods = { write: clip.write, writeText: clip.writeText, execCommand: document.execCommand };
        clip.write = clip.writeText = () => Promise.reject(Error('clipboard-test-denied'));
        document.execCommand = () => { throw Error('clipboard-test-denied'); };
      });
      const deniedCut = await perform('cut', ['b']);
      const untouched = await context();
      await handle.win.evaluate(() => {
        const before = (window as any).__nativeClipboardMethods;
        Object.assign(navigator.clipboard, { write: before.write, writeText: before.writeText }); document.execCommand = before.execCommand;
      });
      expect(deniedCut).toMatchObject({ ok: false, liveChanged: false });
      expect(untouched.context.elements.some((element: any) => element.id === 'b')).toBe(true);
      expect(await perform('changeOpacity', ['b'], 60)).toMatchObject({ ok: true, durable: true });
      supplemental.push({ name: 'cut-clipboard-denied', result: deniedCut, originalPreserved: true, nextActionContinued: true });
    }
    const coverage = { engineVersion: '0.18.1', registered: actions.length, attempted: report.length,
      declaredButNotRegistered: DECLARED_NATIVE_ACTIONS.filter(name => !registered.has(name)), results: report, supplemental,
      externalBoundaries: { clipboard: 'isolated W3C ClipboardItems/Blobs', filePickers: 'controlled File and writable handle' } };
    writeFileSync(test.info().outputPath('native-action-coverage.json'), JSON.stringify(coverage, null, 2));
    expect(report).toHaveLength(attempted.length);
    expect(report.filter(entry => !entry.result.ok).map(entry => ({ name: entry.name, error: entry.result.error }))).toEqual([]);
    for (const name of ['paste', 'group', 'ungroup', 'undo', 'redo']) {
      const entry = report.find(item => item.name === name);
      if (entry) expect(entry.result.liveChanged, `${name} must change the real scene`).toBe(true);
    }
    await handle.win.screenshot({ path: test.info().outputPath('native-actions.png') });
  } finally {
    await handle.app.close();
  }
});
