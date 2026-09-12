// Single source of truth for IPC handlers wiring, window factory, lifecycle.

import { app, BrowserWindow, shell, protocol, net, Menu, dialog } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { userInfo } from 'node:os';
import { installRouter, okResult, failResult, register } from './ipc/router';
import { registerTodoHandlers } from './ipc/todo-handlers';
import { registerContentHandlers } from './ipc/content-handlers';
import { registerDocumentHandlers } from './ipc/document-handlers';
import { registerLinkHandlers } from './ipc/link-handlers';
import { registerCapturePreviewHandler } from './ipc/capture-preview-handler';
import { logger } from './logger';
import { openDb, type DbHandle } from './db/schema';
import { TodoRepo } from './db/todo-repo';
import { ConversationRepo } from './db/conversation-repo';
import { MarkdownStore } from './files/markdown';
import { DrawingStore } from './files/drawings';
import { DocumentStore } from './files/documents';
import { InboxStore } from './files/inbox';
import { SettingsStore } from './settings/store';
import { CaptureController } from './shortcuts/capture';
import { TrayController } from './tray/tray';
import { ClipboardWatcher } from './clipboard/watcher';
import { installAutoUpdater } from './updater/updater';
import { installAppMenu, showAbout, popupCategory } from './menu';
import { schedulePlanReminder } from './notification/plan-reminder';
import {
  DB_FILENAME,
  TODOS_SUBDIR,
  DRAWINGS_SUBDIR,
  ATTACHMENTS_SUBDIR,
  APP_PRODUCT_NAME,
  APP_USER_MODEL_ID,
} from '../shared/constants';
import type { ULID } from '../shared/todo-types';

// Headless/CI Windows images do not always ship the GPU runtime DLLs Chromium
// probes at startup. Disable acceleration only for E2E so the real application
// keeps its normal hardware-accelerated rendering path.
if (process.env['ELECTRON_E2E'] === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// Single-instance lock. A second launch (e.g. clicking the shortcut while the
// tray app is alive) should surface the existing window, NOT start a second
// process — `app.quit()` on the loser + `second-instance` on the winner handles
// this without ever creating a duplicate window. Applies in both prod and dev:
// in dev each `pnpm dev` previously opened its own window, which contradicts
// the "one app = one window" expectation.
//
// DEV escape hatch: Windows often orphans the electron child when `pnpm dev`
// is Ctrl+C'd, and that orphan keeps holding the lock so the next `pnpm dev`
// gets gotLock=false → app.quit() → no window. Set
// `ELECTRON_ALLOW_MULTI_INSTANCE=1` to bypass the lock in that scenario
// (one-off: kill the orphan or restart Windows, then unset it).
const allowMulti = process.env['ELECTRON_ALLOW_MULTI_INSTANCE'] === '1';
if (allowMulti) {
  logger.warn('ELECTRON_ALLOW_MULTI_INSTANCE=1 — 单实例锁已禁用,可启动多个窗口');
}
const gotLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A second launch tried to start while this one is alive (likely hidden to
    // tray, or just an idle window). Surface the existing window — restore()+
    // focus() alone leave a hidden window hidden, which looks like "the app
    // won't come up" to the user.
    const all = BrowserWindow.getAllWindows();
    if (all[0]) {
      if (all[0].isMinimized()) all[0].restore();
      all[0].show();
      all[0].focus();
    }
  });

  // Windows taskbar identity. The running EXE in `pnpm dev` / `pnpm preview`
  // is electron.exe — without these calls the taskbar's right-click menu
  // shows "Electron" + the Electron icon (Windows pulls the display name +
  // icon from the AUMID shortcut, which it builds from the EXE's metadata
  // the first time the AUMID is registered). And a different AUMID across
  // dev vs packaged builds would split the app into two taskbar entries on
  // upgrade. Setting the name + a stable reverse-DNS AUMID before the first
  // window opens registers the taskbar entry under our identity and matches
  // the packaged build's `appId` from package.json.
  //
  // Order matters. Electron's `app.setName()` on Windows internally calls
  // `SetCurrentProcessExplicitAppUserModelID(name)` IF no explicit AUMID has
  // been set yet — so calling `setName` FIRST registers "AI待办" as the
  // taskbar display label, then `setAppUserModelId` overrides the id with a
  // stable reverse-DNS string (matching the packaged build's appId) without
  // disturbing the display label.
  //
  // userData preservation: `app.setName()` also shifts the implicit userData
  // directory (default = %APPDATA%/<appName>). Capture the current path
  // BEFORE the rename so existing dev users' data at %APPDATA%/todo-list
  // isn't orphaned on upgrade. `setPath` re-asserts the original — currently
  // package.json's productName already yields %APPDATA%/AI待办 so this is a
  // no-op today, but it guards against future productName drift.
  const userDataPath = app.getPath('userData');
  app.setName(APP_PRODUCT_NAME);
  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setPath('userData', userDataPath);

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
  {
    // attachment://<id> serves an inbox_attachments row's file bytes. Lets the
    // WYSIWYG progress doc embed <img src="attachment://<id>"> without inlining
    // base64 and without ever exposing the main-process absolute path.
    scheme: 'attachment',
    privileges: { secure: true, supportFetchAPI: true, corsEnabled: true },
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
          // app://todo-list/<path> -> out/renderer/<path>
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
    const { TaskDirectoryStore } = await import('./files/task-directories');
    const taskDirectories = new TaskDirectoryStore(handle.db, todosDir);
    const conversations = new ConversationRepo(handle.db);

    // v1 → v2 layout migration sweep. Runs once per process (marker file
    // makes it idempotent). Old flat files get relocated into per-task dirs
    // before any new code touches them. Fire-and-forget so a slow sweep on
    // a large data dir doesn't block the IPC router boot — subsequent file
    // ops simply see the post-migration layout.
    try {
      const { migrateV1Layout } = await import('./files/migrate-v1-layout');
      void migrateV1Layout({
        dataDir: rootDir,
        todosDir,
        drawingsDir,
        attachmentsDir,
        db: handle.db,
      }).catch((err) => {
        logger.warn(`migrateV1Layout: ${(err as Error).message}`);
      });
    } catch (err) {
      logger.warn(`migrateV1Layout import failed: ${(err as Error).message}`);
    }

    // Per-task dir lookup. The relative directory name is persisted in DB;
    // all document stores therefore agree on one directory even after a
    // title change or a failed filesystem rename.
    const resolveTaskDir = (id: ULID): string => taskDirectories.resolve(id);
    const md = new MarkdownStore(handle.db, todosDir, resolveTaskDir);
    const drawings = new DrawingStore(handle.db, drawingsDir, resolveTaskDir);
    const docs = new DocumentStore(handle.db);
    const inbox = new InboxStore(handle.db, attachmentsDir, todosDir, resolveTaskDir);

    // Wire IPC router
    installRouter();
    registerTodoHandlers(repo, md, handle.db, todosDir, resolveTaskDir, taskDirectories);
    registerContentHandlers(md, drawings, repo);
    registerDocumentHandlers(docs, resolveTaskDir);
    registerLinkHandlers();
    registerInboxHandlers(inbox);

    // attachment://<id> → serve the inbox_attachments file bytes. Registered
    // after the inbox store exists so the handler closure can capture it.
    protocol.handle('attachment', async (req) => {
      try {
        const u = new URL(req.url);
        const id = decodeURIComponent(u.host);
        const att = inbox.get(id);
        if (!att) return new Response('not found', { status: 404 });
        const buf = readFileSync(att.filePath);
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: { 'Content-Type': att.mime, 'Cache-Control': 'no-cache' },
        });
      } catch (err) {
        logger.error(`attachment protocol: ${(err as Error).message}`);
        return new Response('not found', { status: 404 });
      }
    });
    registerSettingsHandlers(settings, handle, rootDir);
    registerAppHandlers(() => main);
    registerCaptureHandlers(repo, md);
    registerCapturePreviewHandler();

    // AI-context: focus pointer (renderer→main "what's open") + open task dir.
    // Tasks are stored as flat .md files under <rootDir>/todos/; there is no
    // per-task directory. The openTaskDir handler resolves to the file and
    // uses shell.showItemInFolder so the OS file manager opens todos/ with
    // the task's .md file highlighted — see ipc/app-handlers.ts.
    const { registerAppFocusHandlers } = await import('./ipc/app-handlers');
    registerAppFocusHandlers({
      resolveTaskDir: (todoId) => resolveTaskDir(todoId as ULID),
      todosDir,
    });

    // Set DSH_SESSIONS_ROOT BEFORE importing the DSH container, because the
    // cordis YAML loader evaluates `!js` expressions (like
    // `process.env.DSH_SESSIONS_ROOT`) at boot time when it parses
    // resources/dsh/cordis.yml. The plugin needs an absolute, writable path
    // (rootDir is the user's chosen data directory; dsh-sessions/ sits beside
    // the DB + todos + drawings so everything is co-located and survives an
    // uninstall via the same retention rules).
    const sessionsRoot = join(rootDir, 'dsh-sessions');
    mkdirSync(sessionsRoot, { recursive: true });
    process.env['DSH_SESSIONS_ROOT'] = sessionsRoot;

    // Show the window as soon as the todo IPC + file stores are ready so the
    // app feels instant. DSH container boot (cordis plugin loading +
    // session-persistence backend init) is the dominant startup cost and is
    // deferred to a background promise below. The AI panel is closed by
    // default; its IPC handlers return `ai_not_ready` until DSH resolves, so
    // a user who opens the AI pane in the first second sees the lazy
    // "加载中…" fallback rather than a blank frozen shell.
    const main = createMainWindow();
    main.once('ready-to-show', () => main.show());

    // DSH container (AI runtime) — lazy imported so app launches even if DSH
    // init fails. Fire-and-forget so window show isn't blocked by cordis
    // plugin loading + session-persistence backend init. AI IPC handlers
    // return `ai_not_ready` until this resolves.
    void (async () => {
      try {
        const { initDshContainer } = await import('./dsh/container');
        const dsh = await initDshContainer({ repo, md, drawings, settings, db: handle.db, docs });
        const { registerAiHandlers, bindAiDeps } = await import('./ipc/ai-handlers');
        registerAiHandlers(dsh);
        bindAiDeps({ dsh, settings, repo, conversations, md, drawings, docs, db: handle.db, attachmentsDir });
        logger.info('DSH AI handlers registered');

        // L3-C: backfill DB rows for sessions that exist on disk but have no
        // conversations row. Runs once per boot, idempotent — safe to re-run.
        // We don't await: the migration is best-effort and the renderer's
        // first conversation.list() call will pick up whatever rows are ready.
        try {
          const { migrateOrphanSessions } = await import('./dsh/dsh-runtime');
          void migrateOrphanSessions(conversations).catch((err) => {
            logger.warn(`migrateOrphanSessions: ${(err as Error).message}`);
          });
        } catch (err) {
          logger.warn(`migrateOrphanSessions import failed: ${(err as Error).message}`);
        }
      } catch (err) {
        logger.error(`DSH init skipped: ${(err as Error).message}`);
      }
    })();

    // External SDK + JSON-RPC bridge for plugins / scripts — also deferred
    // so it never blocks window show.
    void (async () => {
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
    })();

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
        const todo = repo.create({ title: text.slice(0, 200) });
        md.writeBody(todo.id, text);
      },
      (filePath) => {
        const todo = repo.create({ title: `剪贴板图片 ${new Date().toLocaleString()}` });
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

    // Chinese application menu (menu bar auto-hidden — press Alt to reveal).
    // `main` was created earlier (before DSH init) so the window shows fast;
    // the menu just attaches to it here.
    installAppMenu({
      onCapture: () => capture.toggle(),
      getMainWindow: () => main,
    });

    // Auto-update
    installAutoUpdater();

    // Auto-archive: sweep done tasks older than the configured threshold
    // (archiveAfterDays) into the archived bin so the active list stays
    // decluttered. Runs once at boot and every hour; reads the threshold
    // fresh each run so a settings change takes effect without a restart.
    // 0 = auto-archive disabled (the sweep is a no-op). Idempotent — only
    // newly-eligible tasks get touched.
    const runArchiveSweep = (): void => {
      const days = settings.get().archiveAfterDays;
      if (!days || days <= 0) return;
      const cutoff = Date.now() - days * 86_400_000;
      const n = repo.archiveStale(cutoff);
      if (n > 0) logger.info(`auto-archive: archived ${n} done task(s) older than ${days} day(s)`);
    };
    runArchiveSweep();
    const archiveTimer = setInterval(runArchiveSweep, 3_600_000);
    app.on('before-quit', () => clearInterval(archiveTimer));

    // "今天安排些什么？" 定时提醒 —— 每小时 tick 一次，到 dailyPlanReminderTime
    // 且今天还没有任何 planned_for 时弹一条系统通知；点击通知聚焦主窗口并
    // 触发渲染端的 plan-guide modal（app:plan-guide 事件）。
    const planReminder = schedulePlanReminder({
      settings,
      repo,
      getMainWindow: () => main,
    });
    app.on('before-quit', () => planReminder.stop());

    // Close main = hide to tray (don't quit) — but in dev, quit instead so the
    // dev process dies and the single-instance lock releases; otherwise the
    // hidden instance blocks every subsequent `pnpm dev` from coming up.
    main.on('close', (e) => {
      if (!isQuitting && !isDev) {
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
  // Windows taskbar reliably shows the window icon only from a real .ico — a
  // bare .png falls back to the electron.exe default in `pnpm dev` (no .ico is
  // generated there because electron-builder only makes one at packaging).
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = isDev
    ? join(__dirname, '../../resources/', iconName)
    : join(process.resourcesPath, iconName);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#FFFFFF',
    title: 'AI待办',
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
    void win.loadURL('app://todo-list/index.html');
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function registerInboxHandlers(inbox: InboxStore): void {
  register('inbox.attach', async (_e, req) => {
    try {
      return okResult(inbox.attach(req.id, req.filePath, req.mime));
    } catch (err) {
      return failResult('attach_failed', (err as Error).message);
    }
  });

  // Pasted image from the renderer arrives as a data: URL. Decode + persist.
  register('inbox.attachBlob', async (_e, req) => {
    try {
      return okResult(inbox.attachBlob(req.todoId, req.dataUrl, req.filename, req.mime));
    } catch (err) {
      return failResult('attach_blob_failed', (err as Error).message);
    }
  });

  register('inbox.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(inbox.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('inbox_list_failed', (err as Error).message));
    }
  });

  // Return file bytes as a data: URL so the renderer can embed them (e.g.
  // <img src>) without ever learning the main-process absolute path.
  register('inbox.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(inbox.read(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('inbox_read_failed', (err as Error).message));
    }
  });

  register('inbox.remove', (_e, req) => {
    try {
      inbox.remove(req.id);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('inbox_remove_failed', (err as Error).message));
    }
  });

  logger.info('inbox.* handlers registered');
}

/** Broadcast a content-scope data-changed so attachment list/views refetch
 *  after a remove (mirrors the document/progress broadcast pattern). */
function broadcastDataChanged(scope: 'content'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}

/** Best-effort mime-type from extension. Returns 'application/octet-stream'
 *  for unknown extensions so callers can branch on a known set. */
/** Best-effort mime-type from extension. Returns 'application/octet-stream'
 *  for unknown extensions so callers can branch on a known set. */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rb': 'text/x-ruby',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.kt': 'text/x-kotlin',
    '.swift': 'text/x-swift',
    '.c': 'text/x-c',
    '.h': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.hpp': 'text/x-c++',
    '.sh': 'text/x-shellscript',
    '.bash': 'text/x-shellscript',
    '.zsh': 'text/x-shellscript',
    '.sql': 'text/x-sql',
    '.toml': 'application/toml',
    '.ini': 'text/plain',
    '.conf': 'text/plain',
    '.env': 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Heuristic text/binary check. Treat the file as binary if any of the
 *  first 8 KiB is a NUL byte or a high ratio of bytes are outside printable
 *  ASCII + common whitespace. */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8 * 1024));
  if (sample.length === 0) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0) return false;
    // Allow printable ASCII (0x20-0x7E), tab, LF, CR, and high-bit bytes
    // (UTF-8 multibyte sequences). Anything else (e.g. 0x01-0x08, 0x0B,
    // 0x0C, 0x0E-0x1F) is suspicious but only counts toward the ratio.
    const printable =
      (b >= 0x20 && b <= 0x7e) ||
      b === 0x09 || b === 0x0a || b === 0x0d ||
      b >= 0x80;
    if (!printable) bad++;
  }
  return bad / sample.length < 0.05;
}

function registerSettingsHandlers(
  store: SettingsStore,
  handle: DbHandle,
  oldRootDir: string,
): void {
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
      ...(req.customProviderId !== undefined ? { customProviderId: req.customProviderId } : {}),
      ...(req.archiveAfterDays !== undefined ? { archiveAfterDays: req.archiveAfterDays } : {}),
      ...(req.tags ? { tags: req.tags } : {}),
      ...(req.dailyPlanReminderTime !== undefined ? { dailyPlanReminderTime: req.dailyPlanReminderTime } : {}),
      ...(req.lastPlanGuideDate !== undefined ? { lastPlanGuideDate: req.lastPlanGuideDate } : {}),
      ...(req.snoozePlanGuideUntil !== undefined ? { snoozePlanGuideUntil: req.snoozePlanGuideUntil } : {}),
    });
    if (req.customProviders) {
      store.mergeCustomProviders(req.customProviders);
    }
    // Broadcast so non-modal consumers of settings (e.g. the TagInput
    // autocomplete in the task detail) refresh their registry live.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('app:settings-changed', {});
    }
    return Promise.resolve(okResult(store.publicView()));
  });
  // Native folder picker. On confirm: checkpoint + close the DB so the SQLite
  // file (and WAL) are consistent, recursively copy the old data dir into the
  // new location (DB + markdown + drawings + attachments), persist the new
  // dataDir, then relaunch from the migrated copy. The config.json lives in
  // userData (stable), so it survives untouched.
  //
  // If the chosen directory ALREADY contains data, we do NOT silently
  // overwrite it. We prompt: 替换 (overwrite with current data) / 不替换
  // (keep the target's existing data, just switch to it) / 取消 (abort,
  // leave everything untouched).
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

      // Refuse a no-op or nested-in-source move that would recurse forever.
      if (chosen === oldRootDir || oldRootDir.startsWith(chosen + '\\') || oldRootDir.startsWith(chosen + '/')) {
        return failResult('invalid_data_dir', '新数据目录不能是当前目录的父目录或其本身');
      }

      mkdirSync(chosen, { recursive: true });

      // Decide whether to copy current data into the target. If the target
      // already has data, we must NOT silently clobber it — ask the user.
      //   替换   → overwrite (force copy current data into the target)
      //   不替换 → keep the target's existing data, just switch dataDir
      //            (the app loads whatever already lives at `chosen`)
      //   取消   → abort, leave everything untouched
      let doCopy = true;       // copy current data into the target?
      let prompted = false;   // did we ask the overwrite question?
      const existing = readdirSync(chosen);
      if (existing.length > 0) {
        prompted = true;
        const choice = await dialog.showMessageBox(win as never, {
          type: 'warning',
          title: '目标目录已有数据',
          message: `所选目录「${chosen}」中已存在数据。`,
          detail:
            '替换：用当前数据覆盖目标目录中的现有数据。\n' +
            '不替换：保留目标目录中的现有数据，直接切换到该目录（不复制当前数据）。',
          buttons: ['替换', '不替换', '取消'],
          defaultId: 2, // cancel = safe default
          cancelId: 2,
          noLink: true, // predictable button order on Windows
        });
        if (choice.response === 2) {
          // Cancel — nothing touched, DB still open.
          return okResult({ path: null });
        }
        doCopy = choice.response === 0; // 0 = 替换 → copy; 1 = 不替换 → skip
      }

      if (doCopy) {
        // Flush WAL into the main db file and close the handle so the
        // on-disk snapshot is consistent before we copy it.
        try {
          handle.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          // best-effort; copy still works on the live file
        }
        handle.close();
        cpSync(oldRootDir, chosen, {
          recursive: true,
          force: true,
          errorOnExist: false,
          dereference: true,
        });
      } else {
        // Not copying — the app will load the existing data at `chosen`
        // after relaunch. Close the current handle cleanly so the
        // relaunch reopens at the new path without a stale lock.
        try { handle.close(); } catch { /* best-effort */ }
      }

      store.patch({ dataDir: chosen });
      logger.info(`dataDir migrated ${oldRootDir} → ${chosen} (copy=${doCopy}, prompted=${prompted}); relaunching`);
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
      const todo = repo.create({ title: req.title });
      md.writeBody(todo.id, req.markdown ?? '');
      return Promise.resolve(okResult({ id: todo.id }));
    } catch (err) {
      return Promise.resolve(failResult('capture_failed', (err as Error).message));
    }
  });
}

function registerAppHandlers(getMainWindow: () => BrowserWindow | null): void {
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
  // Flat topbar category buttons: pop a single category's submenu.
  register('app.popupMenuCategory', async (_e, req) => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      popupCategory(req.category as never, win);
      return okResult(undefined);
    } catch (err) {
      return failResult('popup_menu_failed', (err as Error).message);
    }
  });
  // Native file picker for the AI composer. Reads up to `maxBytes` (default
  // 256 KiB) of the chosen file as utf-8 text and returns both the path and
  // the body so the renderer can inline it into the prompt. Binary / over-
  // limit files return ok=false with a precise code so the renderer can
  // surface a clear message instead of silently truncating.
  const PICK_TEXT_LIMIT_DEFAULT = 256 * 1024;
  register('app.pickFile', async (_e, req) => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const res = await dialog.showOpenDialog(win as never, {
        title: '选择要附加的文件',
        properties: ['openFile'],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return okResult({ canceled: true });
      }
      const filePath = res.filePaths[0]!;
      const stat = statSync(filePath);
      const limit = req.maxBytes ?? PICK_TEXT_LIMIT_DEFAULT;
      const ext = extname(filePath).toLowerCase();
      const mime = mimeFromExt(ext);
      if (stat.size > limit) {
        return failResult('too_large', `文件太大 (${stat.size} 字节)，上限 ${limit} 字节`);
      }
      const buf = readFileSync(filePath);
      if (!looksLikeText(buf)) {
        return failResult('not_text', '文件不是可读文本，请选择代码或文本文件');
      }
      const text = buf.toString('utf8');
      return okResult({
        canceled: false,
        path: filePath,
        name: basename(filePath),
        mime,
        size: stat.size,
        text,
      });
    } catch (err) {
      return failResult('pick_file_failed', (err as Error).message);
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
  // OS username for the bottom-left user chip — no hardcoded preset. Uses
  // os.userInfo().username (on Windows, the login name). null if it can't be
  // resolved, in which case the chip renders a neutral avatar only.
  register('app.osUser', async () => {
    try {
      const username = userInfo().username ?? null;
      return okResult({ username });
    } catch (err) {
      return failResult('os_user_failed', (err as Error).message);
    }
  });
  // Dim / restore the frameless titleBarOverlay (native min/max/close
  // glyphs). The overlay is rendered by Chromium above the webContents, so
  // the renderer's dimmed-backdrop CSS can't reach it — without this,
  // opening a modal leaves the native glyphs at their default light-grey
  // colour, which clashes with the dimmed client area beneath.
  //
  // Colours chosen to land on the same gray-shifted-mid-luminance band the
  // modal backdrop ends up at on a typical light-mode topbar (translucent
  // black over #F6F7F9 → ~ #7B7E84 after blending, with a near-black glyph
  // for contrast against that mid-gray background). Tweak here if you
  // change the backdrop tint.
  const TITLEBAR_OVERLAY_LIGHT = { color: '#F6F7F9', symbolColor: '#4A4F57' };
  const TITLEBAR_OVERLAY_DIM = { color: '#7B7E84', symbolColor: '#1F2329' };
  register('app.setTitleBarOverlay', (_e, req) => {
    try {
      // macOS uses traffic-light buttons, not a titleBarOverlay — skip
      // silently rather than spamming dev logs with "not supported".
      if (process.platform === 'darwin') return Promise.resolve(okResult(undefined));
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return Promise.resolve(okResult(undefined));
      win.setTitleBarOverlay(req.dim ? TITLEBAR_OVERLAY_DIM : TITLEBAR_OVERLAY_LIGHT);
      return Promise.resolve(okResult(undefined));
    } catch (err) {
      return Promise.resolve(failResult('set_title_bar_overlay_failed', (err as Error).message));
    }
  });
  logger.info('app.* handlers registered');
}

