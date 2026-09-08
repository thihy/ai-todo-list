// Single source of truth for IPC handlers wiring, window factory, lifecycle.

import { app, BrowserWindow, shell, protocol, net, Menu } from 'electron';
import { join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';
import { basename } from 'node:path';
import { installRouter, okResult, failResult, register } from './ipc/router';
import { registerTodoHandlers } from './ipc/todo-handlers';
import { registerContentHandlers } from './ipc/content-handlers';
import { logger } from './logger';
import { openDb, newId } from './db/schema';
import { TodoRepo } from './db/todo-repo';
import { MarkdownStore } from './files/markdown';
import { DrawingStore } from './files/drawings';
import { SettingsStore } from './settings/store';
import { CaptureController } from './shortcuts/capture';
import { TrayController } from './tray/tray';
import { ClipboardWatcher } from './clipboard/watcher';
import { installAutoUpdater } from './updater/updater';
import { installAppMenu, showAbout } from './menu';
import {
  DB_FILENAME,
  TODOS_SUBDIR,
  DRAWINGS_SUBDIR,
  ATTACHMENTS_SUBDIR,
} from '../shared/constants';
import type Database from 'better-sqlite3';

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const all = BrowserWindow.getAllWindows();
    if (all[0]) {
      if (all[0].isMinimized()) all[0].restore();
      all[0].focus();
    }
  });
  bootstrap();
}

// Quit flag lives on the module rather than the App instance — module augmentation
// of electron's App interface collides with the way electron's d.ts declares it.
let isQuitting = false;
app.on('before-quit', () => { isQuitting = true; });

// Register `app://` as a privileged scheme so the renderer can use it
// without triggering an "open with…" dialog on Windows. Must be done before
// app.ready so the scheme is recognised by all subsequent load calls.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function bootstrap(): void {
  void app.whenReady().then(async () => {
    // Register `app://` to serve files from out/renderer. We use net.fetch
    // so the same code path works for both disk files (prod) and dev server.
    if (!process.env['ELECTRON_RENDERER_URL']) {
      protocol.handle('app', async (req) => {
        try {
          const u = new URL(req.url);
          // app://thihy-todolist/<path> -> out/renderer/<path>
          const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
          const file = join(__dirname, '../renderer', rel);
          return await net.fetch(`file:///${file.replace(/\\/g, '/')}`);
        } catch (err) {
          logger.error(`protocol handler: ${(err as Error).message}`);
          return new Response('not found', { status: 404 });
        }
      });
    }

    // Settings must be read FIRST so we know the data directory before opening
    // the DB or any file store. The config file itself lives in userData
    // (stable); dataDir points at where DB/markdown/drawings actually live.
    const settings = new SettingsStore();
    const rootDir = settings.getDataDir();
    mkdirSync(rootDir, { recursive: true });
    const dbPath = join(rootDir, DB_FILENAME);
    const todosDir = join(rootDir, TODOS_SUBDIR);
    const drawingsDir = join(rootDir, DRAWINGS_SUBDIR);
    const attachmentsDir = join(rootDir, ATTACHMENTS_SUBDIR);
    mkdirSync(todosDir, { recursive: true });
    mkdirSync(drawingsDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });

    const handle = openDb(dbPath);
    const repo = new TodoRepo(handle.db);
    const md = new MarkdownStore(handle.db, todosDir);
    const drawings = new DrawingStore(handle.db, drawingsDir);

    // Wire IPC router
    installRouter();
    registerTodoHandlers(repo, md);
    registerContentHandlers(md, drawings);
    registerInboxHandlers(handle.db, attachmentsDir);
    registerSettingsHandlers(settings);
    registerAppHandlers();
    registerCaptureHandlers(repo, md);

    // DSH container (AI runtime) — lazy imported so app launches even if DSH init fails
    try {
      const { initDshContainer } = await import('./dsh/container');
      const dsh = await initDshContainer({ repo, md, drawings, settings, db: handle.db });
      const { registerAiHandlers, bindAiDeps } = await import('./ipc/ai-handlers');
      registerAiHandlers(dsh);
      bindAiDeps({ dsh, settings, repo, md, drawings });
      logger.info('DSH AI handlers registered');
    } catch (err) {
      logger.error(`DSH init skipped: ${(err as Error).message}`);
    }

    // External SDK + JSON-RPC bridge for plugins / scripts
    try {
      const { createSdk } = await import('./sdk/sdk');
      const { JsonRpcBridge } = await import('./sdk/bridge');
      const sdk = createSdk({ repo, md, drawings });
      const bridge = new JsonRpcBridge(sdk);
      bridge.start();
      app.on('before-quit', () => bridge.stop());
    } catch (err) {
      logger.warn(`SDK bridge skipped: ${(err as Error).message}`);
    }

    // Capture + tray
    const capture = new CaptureController();
    capture.setHotkey(settings.get().captureHotkey);
    capture.registerHotkey();

    const isDev = !app.isPackaged;
    const trayIconPath = isDev
      ? join(__dirname, '../../resources/tray.png')
      : join(process.resourcesPath, 'tray.png');
    const tray = new TrayController(trayIconPath);
    const clipboard = new ClipboardWatcher();
    clipboard.setHandlers(
      (text) => {
        const todo = repo.create({ title: text.slice(0, 200) }, md.filePathFor('placeholder'));
        md.writeBody(todo.id, text);
      },
      (filePath) => {
        const todo = repo.create(
          { title: `剪贴板图片 ${new Date().toLocaleString()}` },
          md.filePathFor('placeholder'),
        );
        md.writeBody(todo.id, `![clipboard](${filePath})`);
      },
    );
    tray.setHandlers(
      () => capture.toggle(),
      () => {
        clipboard.setPaused(!clipboard.isPaused());
        tray.setClipboardPaused(clipboard.isPaused());
      },
    );
    tray.install();

    // Main window
    const main = createMainWindow();
    main.once('ready-to-show', () => main.show());

    // Chinese application menu (menu bar auto-hidden — press Alt to reveal).
    installAppMenu({
      onCapture: () => capture.toggle(),
      getMainWindow: () => main,
    });

    // Auto-update
    installAutoUpdater();

    // Close main = hide to tray (don't quit)
    main.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault();
        main.hide();
      }
    });

    app.on('window-all-closed', () => {
      // Keep app alive in tray; user quits via tray menu.
    });

    app.on('before-quit', () => {
      capture.destroy();
      tray.destroy();
      handle.close();
    });
  });
}

function createMainWindow(): BrowserWindow {
  const isDev = !app.isPackaged;
  const iconPath = isDev
    ? join(__dirname, '../../resources/icon.png')
    : join(process.resourcesPath, 'icon.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#FFFFFF',
    title: 'thihy-todolist',
    // Frameless with themed native caption buttons (Window Controls Overlay):
    // removes the Windows title bar so the top bar blends with the app chrome.
    // Light overlay matches the topbar surface; native min/max/close stay.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F6F7F9',
      symbolColor: '#4A4F57',
      height: 44,
    },
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // In dev, electron-vite exports the renderer dev server URL via
  // ELECTRON_RENDERER_URL. In prod we fall back to loading the built HTML
  // through the custom `app://` scheme registered above.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL('app://thihy-todolist/index.html');
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function registerInboxHandlers(db: Database.Database, attachmentsDir: string): void {
  register('inbox.attach', async (_e, req) => {
    try {
      const id = newId();
      mkdirSync(attachmentsDir, { recursive: true });
      const filename = `${id}-${basename(req.filePath)}`;
      const target = join(attachmentsDir, filename);
      copyFileSync(req.filePath, target);
      const now = Date.now();
      db.prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, req.id, target, req.mime, now);
      return okResult({ id, todoId: req.id, filePath: target, mime: req.mime, createdAt: now });
    } catch (err) {
      return failResult('attach_failed', (err as Error).message);
    }
  });
  logger.info('inbox.* handlers registered');
}

function registerSettingsHandlers(store: SettingsStore): void {
  register('settings.get', () => Promise.resolve(okResult(store.publicView())));
  register('settings.set', (_e, req) => {
    store.patch({
      ...(req.provider ? { provider: req.provider } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.streaming != null ? { streaming: req.streaming } : {}),
      ...(req.captureHotkey ? { captureHotkey: req.captureHotkey } : {}),
      ...(req.theme ? { theme: req.theme } : {}),
      ...(typeof req.apiKey === 'string' ? { apiKey: req.apiKey } : {}),
      ...(typeof req.dataDir === 'string' ? { dataDir: req.dataDir } : {}),
    });
    return Promise.resolve(okResult(store.publicView()));
  });
  // Native folder picker. On confirm, persist the new dataDir and relaunch so
  // the DB / stores reopen from the new location. The reply is only meaningful
  // when the user cancels; on confirm the process exits before the renderer
  // can act on it.
  register('settings.chooseDataDir', async () => {
    try {
      const { dialog, app: electronApp } = await import('electron');
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const res = await dialog.showOpenDialog(win as never, {
        title: '选择数据目录',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: store.getDataDir(),
      });
      if (res.canceled || res.filePaths.length === 0) {
        return okResult({ path: null });
      }
      const chosen = res.filePaths[0];
      store.patch({ dataDir: chosen });
      logger.info(`dataDir relocated to ${chosen}; relaunching`);
      // Let the reply flush, then restart.
      setImmediate(() => {
        electronApp.relaunch();
        electronApp.exit(0);
      });
      return okResult({ path: chosen });
    } catch (err) {
      return failResult('choose_data_dir_failed', (err as Error).message);
    }
  });
}

function registerCaptureHandlers(repo: TodoRepo, md: MarkdownStore): void {
  register('capture.submit', (_e, req) => {
    try {
      const todo = repo.create({ title: req.title }, md.filePathFor('placeholder'));
      md.writeBody(todo.id, req.markdown ?? '');
      return Promise.resolve(okResult({ id: todo.id }));
    } catch (err) {
      return Promise.resolve(failResult('capture_failed', (err as Error).message));
    }
  });
}

function registerAppHandlers(): void {
  // Title-bar 菜单 button: pop the native application menu at the cursor.
  register('app.popupMenu', async () => {
    try {
      const menu = Menu.getApplicationMenu();
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      menu?.popup({ window: win });
      return okResult(undefined);
    } catch (err) {
      return failResult('popup_menu_failed', (err as Error).message);
    }
  });
  // Bottom-left user menu actions.
  register('app.action', async (_e, req) => {
    try {
      if (req.action === 'quit') {
        isQuitting = true;
        app.quit();
      } else if (req.action === 'about') {
        await showAbout();
      } else if (req.action === 'checkUpdate') {
        const win = BrowserWindow.getFocusedWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('app:update-available', { version: '' });
        }
      }
      return okResult(undefined);
    } catch (err) {
      return failResult('app_action_failed', (err as Error).message);
    }
  });
  logger.info('app.* handlers registered');
}