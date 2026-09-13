// Auto-updater IPC handlers. Wires the renderer-side "检查更新"
// / "立即重启" UI to the electron-updater wrapper in
// `../updates/updater.ts`. Three channels:
//
//   app.updater.status — sync read of the latest known feed state.
//   app.updater.check  — user-initiated feed check; returns the
//                        post-check status or a typed error code
//                        so the renderer can render a useful
//                        message instead of swallowing failure.
//   app.updater.install — quitAndInstall. Triggers app restart.
//
// The auto-check is wired separately (see setUpAutoUpdater's
// 5 s delayed check) and pushes `app:update-available` /
// `app:update-downloaded` events to all BrowserWindows. The
// renderer subscribes to those events to keep its local UI in
// sync with the auto-check's progress.
//
// The dev-mode short-circuit lives inside the updater module;
// these handlers call into it transparently. `devMode: true`
// is returned so the renderer can disable the button instead
// of pretending a check is in flight.

import { okResult, failResult, register } from './router';
import { logger } from '../logger';
import {
  getUpdaterStatus,
  checkNow as updaterCheckNow,
  quitAndInstall as updaterQuitAndInstall,
} from '../updates/updater';
import { app } from 'electron';

function statusToRes(): {
  currentVersion: string;
  latestVersion: string | null;
  downloaded: boolean;
  checking: boolean;
  devMode: boolean;
} {
  const s = getUpdaterStatus();
  return { ...s, devMode: !app.isPackaged };
}

export function registerUpdaterHandlers(): void {
  register('app.updater.status', () => {
    return Promise.resolve(okResult(statusToRes()));
  });

  register('app.updater.check', async () => {
    try {
      await updaterCheckNow();
      return okResult(statusToRes());
    } catch (err) {
      const message = (err as Error).message;
      logger.warn(`updater: user check failed: ${message}`);
      return failResult('check_failed', message);
    }
  });

  register('app.updater.install', () => {
    try {
      updaterQuitAndInstall();
      return Promise.resolve(okResult(undefined));
    } catch (err) {
      const message = (err as Error).message;
      logger.warn(`updater: install failed: ${message}`);
      return failResult('install_failed', message);
    }
  });
}
