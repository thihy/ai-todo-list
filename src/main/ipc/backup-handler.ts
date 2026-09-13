// Backup IPC handler — REL-01 MVP-1.
//
// Registers `app.backup.create { destDir } → BackupCreateRes`.
//
// Failure modes map to typed `BackupError.code` values so the
// renderer can render localised messages:
//   - source_missing   : source data dir disappeared (mid-recovery?)
//   - dest_missing     : user picked a folder that vanished
//   - name_collision   : Math.random collision on the subfolder name
//   - copy_failed      : filesystem refused the copy
//   - backup_failed    : SQLite `.backup()` failed (very rare — usually
//                        disk full or sandbox restriction)
//   - internal_error   : anything else; logged at error with full cause
//
// The handler is read-only w.r.t. the live data dir — it never mutates
// the source, only reads + writes under `destDir`. The DB backup is
// done via better-sqlite3's online backup API which guarantees WAL
// consistency without blocking writers.

import { okResult, failResult, register } from './router';
import type Database from 'better-sqlite3';
import { dialog, BrowserWindow, app } from 'electron';
import { createBackup, BackupError } from '../backup/backup-service';
import { logger } from '../logger';

export function registerBackupHandlers(opts: {
  /** Absolute path to the live data directory. Wired from index.ts. */
  rootDir: string;
  /** better-sqlite3 handle for the live DB. */
  db: Database.Database;
}): void {
  const { rootDir, db } = opts;

  // Native folder picker for the backup destination. Defaults to the
  // user's Documents folder so a non-technical user finds it in their
  // familiar navigation root; the user can navigate elsewhere.
  register('app.backup.chooseDest', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const res = await dialog.showOpenDialog(win as never, {
        title: '选择备份目录',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('documents'),
      });
      if (res.canceled || res.filePaths.length === 0) {
        return okResult({ canceled: true });
      }
      return okResult({ canceled: false, path: res.filePaths[0] });
    } catch (err) {
      const msg = (err as Error).message || '选择目录失败';
      logger.warn(`backup: chooseDest failed: ${msg}`);
      return failResult('pick_failed', msg);
    }
  });

  // Reference the parameter so the unused-warning linter stays quiet
  // (the handler doesn't need rootDir/db itself, but the parent
  // function signature stays future-proof for restore / delete which
  // will need both).
  void rootDir; void db;

  register('app.backup.create', async (_e, req) => {
    // The renderer must have already opened a native folder picker and
    // supplied the user-chosen absolute path. We re-check it exists
    // here because the user could have moved / deleted the folder
    // between picker and click.
    const destDir = req?.destDir;
    if (typeof destDir !== 'string' || destDir.length === 0) {
      return failResult('bad_request', '请选择备份目录');
    }
    try {
      // createBackup is async (awaits the SQLite online backup
      // primitive); await it directly and wrap in okResult.
      const result = await createBackup({ rootDir, db, destDir });
      return okResult(result);
    } catch (err) {
      if (err instanceof BackupError) {
        // Typed error from the service. Map to a typed code + a
        // user-friendly message; the cause is in main logs only.
        logger.warn(`backup: ${err.code}: ${err.message}`);
        return failResult(err.code, err.message);
      }
      const msg = (err as Error).message || '备份失败';
      logger.error(`backup: unexpected error: ${msg}`);
      return failResult('internal_error', msg);
    }
  });
}