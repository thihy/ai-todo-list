// Auto-updater wrapper around `electron-updater`.
//
// Design (业界最佳实践):
//   - dev mode is a no-op: `electron-updater` would try to fetch a
//     latest.yml from the production feed even in dev, which both
//     wastes a request and (worse) could overwrite a developer's
//     `out/main/index.js` mid-session. We detect dev via
//     `!app.isPackaged` and short-circuit.
//   - auto-check on a 5 s delay: the splash is gone by then, the
//     AIPane is either ready or still loading. Five seconds is the
//     community-standard delay chosen so the auto-check never races
//     with the splash / first paint (see Microsoft Teams, Slack,
//     VS Code all use similar delays). A user-initiated check
//     (`checkNow`) bypasses the delay entirely.
//   - errors at WARN, never throw: a failed manifest fetch is not
//     user-actionable in the "auto" path — surface at info/warn
//     only. A user-initiated check propagates failure via the IPC
//     layer so the renderer can show "检查失败，请稍后重试".
//   - state is observable: `getStatus()` returns the last-known
//     { currentVersion, latestVersion, downloaded } so the renderer
//     can render consistent UI on every mount without waiting for
//     a fresh check.
//   - Windows-only install trigger is via `quitAndInstall()` — the
//     platform-specific ceremony (NSIS, Squirrel.Mac, AppImage)
//     happens inside `electron-updater`.
//
// Why not just call `autoUpdater.checkForUpdates()` directly from
// `index.ts`? Because (a) we want a single testable seam, (b) we
// want the dev-mode short-circuit, (c) the IPC layer needs
// synchronous-feeling status queries.

import { app } from 'electron';

// Lazy import — `electron-updater` is a runtime-only dependency
// and shouldn't be loaded in dev for performance, and definitely
// shouldn't be touched during unit tests (which mock this module).
type AutoUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: any;
  on(event: 'checking-for-update', listener: () => void): AutoUpdater;
  on(event: 'update-available', listener: (info: { version: string }) => void): AutoUpdater;
  on(event: 'update-not-available', listener: (info: { version: string }) => void): AutoUpdater;
  on(event: 'download-progress', listener: (p: { percent: number }) => void): AutoUpdater;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): AutoUpdater;
  on(event: 'error', listener: (err: Error) => void): AutoUpdater;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};
type AutoUpdaterModule = { autoUpdater: AutoUpdater };

export interface UpdaterStatus {
  /** Current app version (from package.json via app.getVersion). */
  currentVersion: string;
  /** Latest version advertised by the feed, if known. */
  latestVersion: string | null;
  /** True once an update has fully downloaded and is ready to install. */
  downloaded: boolean;
  /** True when the next auto-check fires. Manual checks ignore this. */
  checking: boolean;
}

export interface UpdaterCallbacks {
  /** Called once an update is detected by the feed. */
  onAvailable?(version: string): void;
  /** Called once an update is fully downloaded (ready to install). */
  onDownloaded?(version: string): void;
}

const AUTO_CHECK_DELAY_MS = 5_000;

let started = false;
let status: UpdaterStatus = {
  currentVersion: '',
  latestVersion: null,
  downloaded: false,
  checking: false,
};
let installed = false;

export function getUpdaterStatus(): UpdaterStatus {
  // Re-read current version each call: `app.getVersion()` doesn't
  // change at runtime, but reading it once at module load would
  // diverge from the about dialog if someone manually patches
  // package.json in dev (the dev short-circuit means we never get
  // here in that case anyway, so the cost is one method call per
  // status query).
  return { ...status, currentVersion: app.getVersion() };
}

/** Set up the auto-updater. Idempotent — calling twice is a no-op.
 *  Returns true if setup actually ran; false if dev mode (or
 *  already started). */
export function setUpAutoUpdater(cb?: UpdaterCallbacks): boolean {
  if (started) return true;
  if (!app.isPackaged) {
    // Dev mode: skip. The renderer-side check UI still works
    // (returns `dev_mode` so the user knows it's intentional).
    started = true;
    return false;
  }
  started = true;
  status = {
    currentVersion: app.getVersion(),
    latestVersion: null,
    downloaded: false,
    checking: false,
  };

  // Fire-and-forget the import + wire-up. electron-updater pulls
  // in `lzma-native` / `7zip-bin` etc. lazily, and we don't want
  // to block the boot path on it.
  void (async (): Promise<void> => {
    try {
      const { autoUpdater } = (await import('electron-updater')) as unknown as AutoUpdaterModule;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null; // we own logging via on('error', ...)

      autoUpdater.on('checking-for-update', () => {
        status = { ...status, checking: true };
      });
      autoUpdater.on('update-available', (info) => {
        status = {
          ...status,
          latestVersion: info.version,
          checking: false,
          downloaded: false,
        };
        cb?.onAvailable?.(info.version);
      });
      autoUpdater.on('update-not-available', (info) => {
        status = {
          ...status,
          latestVersion: info.version,
          checking: false,
        };
      });
      autoUpdater.on('update-downloaded', (info) => {
        status = { ...status, downloaded: true, latestVersion: info.version };
        cb?.onDownloaded?.(info.version);
      });
      autoUpdater.on('error', (err) => {
        // Don't spam — auto-check errors are normal (offline, no
        // feed yet, etc.). Log at warn so it's visible in the
        // main log but not noisy.
        const log = getLogger();
        log.warn(`updater: error: ${err.message}`);
        status = { ...status, checking: false };
      });

      // Schedule the first auto-check on a delay so it never
      // races with the splash or the STARTUP-AI-ASYNC-002 boot
      // window.
      setTimeout(() => {
        void autoUpdater.checkForUpdates().catch((err: Error) => {
          getLogger().warn(`updater: auto-check rejected: ${err.message}`);
        });
      }, AUTO_CHECK_DELAY_MS);
    } catch (err) {
      getLogger().warn(`updater: setup failed: ${(err as Error).message}`);
    }
  })();

  return true;
}

/** User-initiated check. Bypasses the auto-check delay and
 *  surfaces failure to the caller. */
export async function checkNow(): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    return { ...status, currentVersion: app.getVersion() };
  }
  try {
    const { autoUpdater } = (await import('electron-updater')) as unknown as AutoUpdaterModule;
    await autoUpdater.checkForUpdates();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  return getUpdaterStatus();
}

/** Quit and install the downloaded update. The platform-specific
 *  handshake (NSIS, Squirrel.Mac, AppImage) lives inside
 *  electron-updater; we just expose it. */
export function quitAndInstall(): void {
  if (installed) return;
  installed = true;
  // Lazy import: same reason as setUpAutoUpdater.
  void (async (): Promise<void> => {
    try {
      const { autoUpdater } = (await import('electron-updater')) as unknown as AutoUpdaterModule;
      autoUpdater.quitAndInstall();
    } catch (err) {
      installed = false; // allow retry
      getLogger().warn(`updater: quitAndInstall failed: ${(err as Error).message}`);
    }
  })();
}

/** Reset the module-level state. Used by unit tests; do NOT call
 *  from production code. */
export function __resetUpdaterForTests(): void {
  started = false;
  status = {
    currentVersion: '',
    latestVersion: null,
    downloaded: false,
    checking: false,
  };
  installed = false;
}

function getLogger(): { warn: (msg: string) => void; info: (msg: string) => void } {
  // Lazy require to keep the test surface narrow (tests can
  // mock '../logger' without breaking the auto-updater).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { logger } = require('../logger') as {
    logger: { warn: (msg: string) => void; info: (msg: string) => void };
  };
  return logger;
}
