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
import { registerDiagnosticsHandlers } from './ipc/diagnostics-handler';
import { registerHealthHandlers } from './ipc/health-handler';
import { registerUpdaterHandlers } from './ipc/updater-handler';
import { registerBackupHandlers } from './ipc/backup-handler';
import { registerLinkHandlers } from './ipc/link-handlers';
import { registerCapturePreviewHandler } from './ipc/capture-preview-handler';
import { registerStartupHandler } from './ipc/startup-handler';
import { resolveEndpoint } from './dsh/endpoints';
import { registerTagHandlers } from './ipc/tag-handler';
import { startupState } from './startup-state';
import { logger } from './logger';
import { openDb, type DbHandle } from './db/schema';
import { TodoRepo } from './db/todo-repo';
import { TagRepo } from './db/tag-repo';
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
  DSH_WORKSPACE_SUBDIR,
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
  // whenReady fires after Chromium has finished its own setup; measure from
  // there so the logs reflect "time the user is waiting for content", not
  // cold-process / disk-paging noise.
  void app.whenReady().then(async () => {
    const bootStart = Date.now();
    const mark = (label: string): number => {
      const t = Date.now() - bootStart;
      logger.info(`startup[core]: ${label} @ ${t}ms`);
      return t;
    };

    // Register `app://` to serve files from out/renderer. We use net.fetch
    // so the same code path works for both disk files (prod) and dev server.
    // Cheap (just installs a handler); not timing-meaningful.
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

    // Phase: window-ready comes very early so the renderer's static splash
    // can paint before we finish core init. Window creation only — IPC +
    // stores finish before window.show() fires (ready-to-show waits for the
    // first paint, so we want the page to load the splash first).
    startupState.setCorePhase('window');
    const main = createMainWindow();
    main.once('ready-to-show', () => {
      logger.info(`startup[core]: window shown @ ${Date.now() - bootStart}ms`);
      main.show();
    });
    mark('window-created');

    // Phase: settings + data dir + DB. Synchronous on purpose — the renderer
    // is gated on core-ready (see startup-state.markCoreReady below), so we
    // can't honestly mark the app usable until the DB has been opened and
    // migrations have completed. We do NOT mark core-ready for the renderer
    // to start fetching todos — that comes after the file stores are also
    // constructed.
    startupState.setCorePhase('settings');
    const settings = new SettingsStore();
    const rootDir = settings.getDataDir();
    mark('settings-loaded');

    startupState.setCorePhase('data-dir');
    mkdirSync(rootDir, { recursive: true });
    const dbPath = join(rootDir, DB_FILENAME);
    const todosDir = join(rootDir, TODOS_SUBDIR);
    const drawingsDir = join(rootDir, DRAWINGS_SUBDIR);
    const attachmentsDir = join(rootDir, ATTACHMENTS_SUBDIR);
    // AI 助手文件系统 / shell 工具的工作区（DSH sandbox-policy 的 workspaceRoot
    // + host `tools/pre-execute` 路径校验的目标）。在 attachmentsDir 之后一并
    // 创建；DSH_WORKSPACE_ROOT env 在 boot DSH container 之前再设置（见下）。
    const dshWorkspaceDir = join(rootDir, DSH_WORKSPACE_SUBDIR);
    mkdirSync(todosDir, { recursive: true });
    mkdirSync(drawingsDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });
    mkdirSync(dshWorkspaceDir, { recursive: true });
    mark('data-dirs-created');

    startupState.setCorePhase('db-open');
    const handle = openDb(dbPath);
    mark('db-opened');

    // TagRepo owns the tag_catalog table + rename/merge/cleanup flow. The
    // TodoRepo hook below ensures any tag name attached to a task (incl.
    // ones AI tools created) lands in the catalog without a separate
    // settings-page round-trip. After schema migration we backfill the
    // catalog from `tags` association table + the legacy settings.tags
    // array — both paths are idempotent (INSERT OR IGNORE on name).
    const tagRepo = new TagRepo(handle.db);
    const repo = new TodoRepo(handle.db, (names) => tagRepo.activateUsedNames(names));
    const { TaskDirectoryStore } = await import('./files/task-directories');
    const taskDirectories = new TaskDirectoryStore(handle.db, todosDir);
    const conversations = new ConversationRepo(handle.db);

    // Post-migration catalog backfill. Two idempotent steps:
    //   1. Task-applied names (every distinct tag in the `tags` association
    //      table that the v17 migration already seeded).
    //   2. Legacy settings.tags — the old userData/config.json registry.
    //      This is the ONE compatibility import. After this point the
    //      catalog is the source of truth; settings.tags is ignored.
    try {
      const addedFromTasks = tagRepo.ensureFromTagsTable();
      if (addedFromTasks.length > 0) {
        logger.info(`tag-catalog: backfilled ${addedFromTasks.length} name(s) from task tags`);
      }
      const legacy = settings.get().tags ?? [];
      if (legacy.length > 0) {
        const r = tagRepo.importEntries(legacy);
        if (r.added > 0) {
          logger.info(`tag-catalog: imported ${r.added} legacy settings.tags entry(ies)`);
        }
      }
    } catch (err) {
      // Backfill failure must NOT block boot — the catalog starts empty
      // and subsequent writes via the hook will populate it. Log and
      // move on.
      logger.warn(`tag-catalog: post-migration backfill failed: ${(err as Error).message}`);
    }
    mark('tag-catalog-seeded');

    startupState.setCorePhase('file-stores');
    // Per-task dir lookup. The relative directory name is persisted in DB;
    // all document stores therefore agree on one directory even after a
    // title change or a failed filesystem rename.
    const resolveTaskDir = (id: ULID): string => taskDirectories.resolve(id);
    const md = new MarkdownStore(handle.db, todosDir, resolveTaskDir);
    const drawings = new DrawingStore(handle.db, drawingsDir, resolveTaskDir);
    const docs = new DocumentStore(handle.db);
    const inbox = new InboxStore(handle.db, attachmentsDir, todosDir, resolveTaskDir);
    mark('file-stores-constructed');

    // UX-01 — the IPC handler receives an object so it can dereference
    // `retryAi` on every call. We pre-bind the object with placeholder
    // closures, then mutate the fields after `bootAiAndDispatch` is defined.
    // This is necessary because the IPC handler is registered before the
    // AI boot body is constructed (the handler must exist by the time the
    // renderer mounts), and we want it to see the real closures without
    // having to re-register.
    //
    // STARTUP-AI-ASYNC-002 — `onRendererReady` is the second hook on the
    // same object: the FIRST `app.renderer.ready` IPC arrival kicks off
    // `bootAiAndDispatch('boot')`. Subsequent arrivals (renderer reload,
    // second window, StrictMode double-effect) return immediately
    // because the underlying `runtimePromise` is the same single-flight
    // bootstrap that UX-01 retry also shares.
    const retryHooks: {
      retryAi: () => boolean;
      onRendererReady: () => boolean;
    } = {
      retryAi: () => false,
      onRendererReady: () => false,
    };
    let bootAiAndDispatch: (reason: 'boot' | 'retry') => void = () => {
      /* replaced below once AI boot body is defined */
    };

    // Phase: business IPC. Must register before the renderer is told core
    // is ready (otherwise the first todo.list would hit no_handler and the
    // splash would stay up).
    startupState.setCorePhase('ipc');
    installRouter();
    registerStartupHandler(retryHooks);
    registerTodoHandlers(repo, md, handle.db, todosDir, resolveTaskDir, taskDirectories);
    registerContentHandlers(md, drawings, repo);
    registerDocumentHandlers(docs, resolveTaskDir, todosDir);
    registerLinkHandlers();
    registerInboxHandlers(inbox);
    registerTagHandlers(tagRepo);

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
    registerDiagnosticsHandlers(settings, handle.db);
    registerHealthHandlers(handle.db);
    // Auto-updater (electron-updater → GitCode releases feed).
    // The IPC handlers register here; the actual auto-check fires
    // only after the renderer's `app.renderer.ready` handshake
    // (see onRendererReady below) so the check never races with
    // the splash or the STARTUP-AI-ASYNC-002 boot window.
    registerUpdaterHandlers();
    // REL-01 MVP-1: backup creation only (restore + delete are scoped
    // for the next iteration). The handler is read-only w.r.t. the
    // live data dir — it never mutates the source. Hot path cost is
    // bounded by the size of `todos.db` + the durable file
    // projections; the SQLite copy uses better-sqlite3's online
    // backup API which handles WAL correctly.
    registerBackupHandlers({ rootDir, db: handle.db });
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
    mark('ipc-registered');

    // Phase: core ready. From this point the renderer's splash can mount
    // the main App and start querying todos. The splash itself polls
    // app.startup.get() + app:startup events and only removes itself when
    // core.status === 'ready'. AI status is intentionally independent and
    // does not block the splash from coming down.
    startupState.markCoreReady();

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
    // 同上：DSH sandbox-policy / dsh-fs-sandbox 的 workspaceRoot 来自
    // `process.env.DSH_WORKSPACE_ROOT`（cordis.yml 用 !!js 表达式读取）。
    // 在 import DSH container 之前 set；mkdirSync 已在 data-dir 阶段完成。
    process.env['DSH_WORKSPACE_ROOT'] = dshWorkspaceDir;

    // Phase: AI runtime. STARTUP-DSH-001 — the splash now waits for the
    // DSH bootstrap to reach a terminal state (ready OR failed) before
    // unmounting, so the user never sees a blank AI pane caused by a
    // first-click cold boot. The boot body is still extracted to
    // `bootAiAndDispatch()` so the `app.startup.retry { component: 'ai' }`
    // IPC handler (UX-01) can re-run the same boot after a previous
    // failure.
    //
    // The first invocation uses `reason: 'boot'` and calls
    // `setAiPhase('ai-loading')`; retries use `reason: 'retry'` and ask
    // `startupState.tryStartAiRetry()` to own the loading transition +
    // single-flight guard.
    //
    // Inside the async IIFE we now `await warmupDshRuntime(...)` —
    // this is the SAME module-scoped `runtimePromise` that ai-handlers
    // use on the lazy path, so there is exactly one Cordis context per
    // process lifetime. After warm-up resolves we run the orphan-session
    // migration against the live runtime's persistence facade; migration
    // failure is logged at warn but does NOT downgrade ai from ready to
    // failed (per step 五 compatibility requirements: migration isn't a
    // hard runtime dependency).
    bootAiAndDispatch = (reason: 'boot' | 'retry'): void => {
      if (reason === 'retry') {
        if (!startupState.tryStartAiRetry()) {
          // Either another retry is already in flight, or the AI component
          // is not currently in 'failed'. Either way: nothing to do. The
          // boot AI block is intentionally silent on this path — the
          // caller (IPC handler) returns `accepted:false` so the renderer
          // can surface a consistent UX.
          logger.info('startup[ai]: retry rejected (not in failed state)');
          return;
        }
      } else {
        startupState.setAiPhase('ai-loading');
      }
      void (async () => {
        const aiStart = Date.now();
        try {
          // UX-01 retry: dispose any cached runtime (live or rejected)
          // BEFORE re-booting. The first-time boot has nothing to dispose.
          const { resetDshRuntimeForRetry, warmupDshRuntime, migrateOrphanSessions } =
            await import('./dsh/dsh-runtime');
          await resetDshRuntimeForRetry();
          const { initDshContainer } = await import('./dsh/container');
          const dsh = await initDshContainer({ repo, md, drawings, settings, db: handle.db, docs });
          const { registerAiHandlers, bindAiDeps } = await import('./ipc/ai-handlers');
          registerAiHandlers(dsh);
          bindAiDeps({ dsh, settings, repo, conversations, md, drawings, docs, db: handle.db, attachmentsDir });
          logger.info(`startup[ai]: DSH handlers registered (${reason}) @ ${Date.now() - aiStart}ms`);

          // The splash gate. warmupDshRuntime awaits the live DSH
          // runtime (Cordis boot + adapter + tools + persistence +
          // listeners). Throws DshBootFailedError on local failure.
          const runtime = await warmupDshRuntime({
            getEndpoint: () => resolveEndpoint(settings.get()),
            repo,
            md,
            drawings,
            docs,
            conversations,
            db: handle.db,
            attachmentsDir,
            settings,
          });
          logger.info(`startup[ai]: DSH runtime warmed (${reason}) @ ${Date.now() - aiStart}ms`);

          // Orphan-session migration. Reuses the SAME persistence
          // facade that warm-up just built — no second Cordis boot.
          // Failure here is non-fatal (per migration contract).
          try {
            await migrateOrphanSessions(conversations, runtime.persistence);
            logger.info(`startup[ai]: orphan migration complete (${reason}) @ ${Date.now() - aiStart}ms`);
          } catch (migErr) {
            logger.warn(`startup[ai]: orphan migration failed (${reason}, non-fatal): ${(migErr as Error).message}`);
          }

          startupState.markAiReady();
        } catch (err) {
          logger.error(`startup[ai]: DSH init failed (${reason}) after ${Date.now() - aiStart}ms: ${(err as Error).message}`);
          startupState.markAiFailed((err as Error).message);
        } finally {
          // Clear the single-flight guard regardless of outcome. The guard
          // is also a no-op once the component reaches a terminal state
          // (ready/failed), but clearing it keeps the invariant local.
          if (reason === 'retry') startupState.finishAiRetry();
        }
      })();
    };

    // STARTUP-AI-ASYNC-002 — DO NOT call `bootAiAndDispatch('boot')`
    // here. Previously the splash gate was `core.ready AND ai.ready/
    // failed`; under that gate, the renderer held the splash up until
    // DSH finished booting (measured ~22 s on cold cache) and the
    // heavy boot sometimes starved Electron's main-process event loop
    // long enough for Windows to mark the BrowserWindow "未响应".
    //
    // The new gate is just `core.status === 'ready'`. We install the
    // retry hook now and rely on `app.renderer.ready` (the first
    // `requestAnimationFrame`-settled React paint) to trigger the
    // actual DSH warm-up. The boot body is still the same single-
    // flight `runtimePromise` that UX-01 retry uses, so a renderer
    // reload mid-boot doesn't fork a second Cordis context.
    //
    // The renderer is expected to call `app.renderer.ready` after
    // first paint; if it never does (e.g. a renderer crash), the AI
    // panel simply stays in 'pending' forever — that is the same
    // state the user sees at cold-start anyway, and the retry
    // banner only appears once ai.status flips to 'failed'.

    // Now that bootAiAndDispatch is defined, install the real closures
    // on the hooks object. The IPC handler dereferences these on
    // every call, so this single mutation is visible immediately. We
    // snapshot ai once before and once after to detect the synchronous
    // transition done inside startupState.tryStartAiRetry(); if status was
    // not 'failed' to begin with, bootAiAndDispatch early-returns and
    // after mirrors before.
    retryHooks.retryAi = (): boolean => {
      const beforeStatus = startupState.snapshot().ai.status;
      bootAiAndDispatch('retry');
      const afterStatus = startupState.snapshot().ai.status;
      return beforeStatus === 'failed' && afterStatus === 'loading';
    };
    // STARTUP-AI-ASYNC-002 — `onRendererReady` is invoked the first
    // time `app.renderer.ready` arrives. We track the boolean
    // ourselves so reloads / duplicate signals don't re-trigger
    // `bootAiAndDispatch` (the underlying `runtimePromise` is
    // single-flight so the boot itself wouldn't run twice, but we'd
    // still log spurious "DSH handlers registered" lines). The
    // hook returns `false` for every duplicate call so the IPC
    // layer's info log can mention the idempotent path.
    let rendererReadyFired = false;
    retryHooks.onRendererReady = (): boolean => {
      const aiSnap = startupState.snapshot().ai;
      // If the AI component has already reached a terminal state
      // (ready / failed) — for example a second window opened after
      // the first window finished booting — there's nothing to do.
      // Returning false here signals "already settled" to the hook
      // consumer (startup-handler.ts) so it can log the no-op.
      if (aiSnap.status === 'ready' || aiSnap.status === 'failed') {
        return false;
      }
      if (rendererReadyFired) {
        return false;
      }
      rendererReadyFired = true;
      bootAiAndDispatch('boot');
      // Auto-updater: kick off after the renderer has painted
      // once. setUpAutoUpdater schedules the first feed check on
      // a 5 s delay (internally); dev mode is a no-op so this is
      // safe under `pnpm dev` too. We import lazily so the DSH
      // boot path doesn't pay for electron-updater's transitive
      // dependencies (lzma-native etc.).
      void (async (): Promise<void> => {
        try {
          const { setUpAutoUpdater } = await import('./updates/updater');
          // Forward electron-updater's two key events to all
          // BrowserWindows so the renderer can keep its about /
          // status UI in sync without polling. The autoUpdate flag
          // is read from the persisted settings store; when false
          // the 5 s post-startup background check is skipped but
          // the listener wiring still happens so manual checkNow /
          // quitAndInstall calls work.
          setUpAutoUpdater(
            {
              onAvailable: (version) => {
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) w.webContents.send('app:update-available', { version });
                }
              },
              onDownloaded: (version) => {
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) w.webContents.send('app:update-downloaded', { version });
                }
              },
            },
            { autoUpdate: settings.get().autoUpdate },
          );
        } catch (err) {
          logger.warn(`updater: failed to start: ${(err as Error).message}`);
        }
      })();
      return true;
    };

    // v1 → v2 layout migration sweep. Deferred until after core-ready so a
    // slow sweep on a large data dir doesn't hold the splash up. We do NOT
    // mark the renderer core-ready until the migration gate is closed
    // (migrateV1Layout's marker file is the marker; the function itself
    // is idempotent). file stores above still see the existing on-disk
    // layout; subsequent file ops simply see whatever migrateV1Layout
    // produced. New task dirs created mid-sweep are not at risk because
    // TaskDirectoryStore uses the DB row, not the FS walk.
    try {
      const { migrateV1Layout } = await import('./files/migrate-v1-layout');
      void migrateV1Layout({
        dataDir: rootDir,
        todosDir,
        drawingsDir,
        attachmentsDir,
        db: handle.db,
      }).then(() => {
        logger.info(`startup[maintenance]: migrateV1Layout done @ ${Date.now() - bootStart}ms`);
      }).catch((err) => {
        logger.warn(`startup[maintenance]: migrateV1Layout failed: ${(err as Error).message}`);
      });
    } catch (err) {
      logger.warn(`startup[maintenance]: migrateV1Layout import failed: ${(err as Error).message}`);
    }

    // STARTUP-DSH-001: orphan-session migration used to run here as a
    // post-core-ready deferred task. It now runs as part of
    // `bootAiAndDispatch` AFTER `warmupDshRuntime` so the migration
    // reuses the live runtime's persistence facade (no second Cordis
    // boot, see STARTUP-DSH-001 step 五). Migration is awaited inside
    // the boot body before `markAiReady()`; on failure we log a warn
    // and still mark ai.ready (migration is not a hard runtime dep).

    // External SDK + JSON-RPC bridge for plugins / scripts. SEC-01: the
    // bridge is OFF by default and only starts when Settings → 数据 →
    // 外部访问 has it enabled. When enabled, the bridge requires a
    // capability token presented on the first line of each connection
    // (see src/main/sdk/bridge.ts). Deferred so it never blocks window
    // show / core-ready.
    void (async () => {
      try {
        const sdkBridge = settings.get().sdkBridge;
        if (!sdkBridge.enabled || !sdkBridge.token) {
          logger.info('startup[maintenance]: SDK bridge disabled (settings.sdkBridge.enabled=false)');
          return;
        }
        const { createSdk } = await import('./sdk/sdk');
        const { JsonRpcBridge } = await import('./sdk/bridge');
        const sdk = createSdk({ repo, md, drawings });
        const bridge = new JsonRpcBridge(sdk, undefined, { token: sdkBridge.token });
        bridge.start();
        app.on('before-quit', () => bridge.stop());
      } catch (err) {
        logger.warn(`startup[maintenance]: SDK bridge skipped: ${(err as Error).message}`);
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
      if (n > 0) logger.info(`startup[maintenance]: auto-archived ${n} done task(s) older than ${days} day(s)`);
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
  register('settings.set', async (_e, req) => {
    // Settings writes hit the disk synchronously inside `store.patch` /
    // `mergeCustomProviders` (writeFileSync on userData/config.json). A full
    // disk, revoked write permission, or read-only volume throws — surface
    // it as an `IpcResult` failure so the renderer's `patch()` can show a
    // toast and keep the user's draft instead of silently dropping the
    // change. We MUST NOT echo the request payload back in the failure
    // message (it carries apiKey / customProviders.apiKey); the renderer
    // already has a typed SettingsPatchError to fall back on.
    try {
      store.patch({
        ...(req.provider ? { provider: req.provider } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.streaming != null ? { streaming: req.streaming } : {}),
        ...(req.captureHotkey ? { captureHotkey: req.captureHotkey } : {}),
        ...(req.theme ? { theme: req.theme } : {}),
        ...(typeof req.apiKey === 'string' ? { apiKey: req.apiKey } : {}),
        ...(typeof req.dataDir === 'string' ? { dataDir: req.dataDir } : {}),
        ...(req.customProviderId !== undefined ? { customProviderId: req.customProviderId } : {}),
        ...(typeof req.userAgent === 'string' ? { userAgent: req.userAgent } : {}),
        ...(req.archiveAfterDays !== undefined ? { archiveAfterDays: req.archiveAfterDays } : {}),
        // NOTE: `tags` is intentionally NOT written here. The v17
        // catalog migration hoisted the tag directory into the DB;
        // UI rename / merge / cleanup all flow through tag.* channels.
        // The legacy userData/config.json entry is preserved on disk
        // for diagnostic purposes but no longer authoritative.
        ...(req.dailyPlanReminderTime !== undefined ? { dailyPlanReminderTime: req.dailyPlanReminderTime } : {}),
        ...(req.lastPlanGuideDate !== undefined ? { lastPlanGuideDate: req.lastPlanGuideDate } : {}),
        ...(req.snoozePlanGuideUntil !== undefined ? { snoozePlanGuideUntil: req.snoozePlanGuideUntil } : {}),
        ...(req.taskAppearance !== undefined ? { taskAppearance: req.taskAppearance } : {}),
        ...(req.taskAppearanceCustomPresets !== undefined ? { taskAppearanceCustomPresets: req.taskAppearanceCustomPresets } : {}),
        ...(typeof req.autoUpdate === 'boolean' ? { autoUpdate: req.autoUpdate } : {}),
      });
      if (req.customProviders) {
        store.mergeCustomProviders(req.customProviders);
      }
      // If the autoUpdate flag was just changed, mirror it into the
      // running updater so the effect is immediate: disabling cancels
      // the pending 5 s scheduled check, re-enabling schedules a new
      // one. Lazy-imported to avoid pulling electron-updater onto the
      // settings write path when the patch is for unrelated fields.
      if (typeof req.autoUpdate === 'boolean') {
        try {
          const { applyAutoUpdatePreference } = await import('./updates/updater');
          applyAutoUpdatePreference(req.autoUpdate);
        } catch (err) {
          // Non-fatal: the value is persisted, so the next launch
          // will pick it up. Logged at warn so it's visible.
          const { logger } = await import('./logger');
          logger.warn(`updater: applyAutoUpdatePreference failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      // Generic, payload-free reason. `err` is intentionally NOT included
      // verbatim — it can mention file paths the user didn't ask to share.
      const reason = err instanceof Error && err.message ? `保存设置失败：${err.message}` : '保存设置失败';
      return Promise.resolve(failResult('settings_set_failed', reason));
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

  // SEC-01 — JSON-RPC bridge toggle. Persists `enabled` and the
  // (possibly newly generated) token. The actual socket start/stop is
  // wired at boot in src/main/index.ts — toggling here takes effect on
  // next launch, which the settings UI surfaces via a hint.
  register('app.sdkBridge.setEnabled', (_e, req) => {
    try {
      const token = store.setSdkBridgeEnabled(Boolean(req?.enabled));
      // Broadcast settings-changed so any other consumers (none today,
      // but future panes) can react.
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:settings-changed', {});
      }
      return okResult({ enabled: Boolean(req?.enabled), token });
    } catch (err) {
      // Never echo the token (it's the user's auth material). The
      // settings UI surfaces a generic failure message.
      return failResult('sdk_bridge_set_enabled_failed', (err as Error).message);
    }
  });

  // SEC-01 — rotate the bridge token. Returns the new token exactly
  // once; the user is expected to copy it immediately. The bridge is
  // always disabled after rotation (see store.rotateSdkBridgeToken).
  register('app.sdkBridge.rotateToken', () => {
    try {
      const token = store.rotateSdkBridgeToken();
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:settings-changed', {});
      }
      return okResult({ token });
    } catch (err) {
      return failResult('sdk_bridge_rotate_failed', (err as Error).message);
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
        // The "检查更新" user-menu item: trigger a user-initiated
        // feed check and broadcast the result back to the
        // focused window so the renderer can update its about
        // pane immediately. We don't await — the renderer also
        // subscribes to `app:update-available` events for the
        // auto-check path, so this just primes the result.
        const win = BrowserWindow.getFocusedWindow();
        void (async (): Promise<void> => {
          try {
            const { checkNow } = await import('./updates/updater');
            await checkNow();
            const { getUpdaterStatus } = await import('./updates/updater');
            const s = getUpdaterStatus();
            if (s.latestVersion) {
              if (win && !win.isDestroyed()) {
                win.webContents.send('app:update-available', { version: s.latestVersion });
              }
            } else {
              // No update found. We don't have a dedicated
              // event for this; the renderer will see the
              // status-quo UI. Logged here so the user has a
              // breadcrumb if they file a bug.
              logger.info('updater: user-initiated check — no update available');
            }
          } catch (err) {
            logger.warn(`updater: user check failed: ${(err as Error).message}`);
          }
        })();
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

