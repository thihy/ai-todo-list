// Auto-update via electron-updater. GitCode Releases feed (declared in package.json → build.publish).
// electron-updater is CommonJS; use default import + destructure under ESM.

import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { logger } from '../logger';

const { autoUpdater } = electronUpdater;

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function installAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => logger.info('checking-for-update'));
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info(`update-available: ${info.version}`);
    broadcast('app:update-available', info);
  });
  autoUpdater.on('update-not-available', () => logger.info('update-not-available'));
  autoUpdater.on('download-progress', (p: ProgressInfo) => logger.info(`download-progress: ${p.percent.toFixed(1)}%`));
  autoUpdater.on('update-downloaded', (e: UpdateDownloadedEvent) => {
    logger.info(`update-downloaded: ${e.version}`);
    broadcast('app:update-downloaded', e);
  });
  autoUpdater.on('error', (err: Error) => logger.error(`auto-updater error: ${err.message}`));

  if (!app.isPackaged) {
    logger.info('auto-update skipped in dev');
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    logger.error(`checkForUpdates failed: ${err.message}`);
  });
}

export function downloadUpdate(): Promise<void> {
  return autoUpdater.downloadUpdate().then(() => undefined);
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}