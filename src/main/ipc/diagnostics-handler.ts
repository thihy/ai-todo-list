// OBS-01 — diagnostics export IPC handler.
//
// Single channel `app.diagnostics.export` returning the redacted
// bundle as JSON. The renderer is expected to write the bundle to
// a user-chosen path via the existing `dialog.showSaveDialog`
// surface (we don't add a new write-file channel to keep the IPC
// surface tight — see ADR-001 §1).

import { okResult, failResult, register } from './router';
import { buildDiagnosticsBundle, serializeBundle } from '../diagnostics/bundle';
import { logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type Database from 'better-sqlite3';
import { dialog, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

export function registerDiagnosticsHandlers(
  settings: SettingsStore,
  db: Database.Database,
): void {
  register('app.diagnostics.export', () => {
    try {
      const bundle = buildDiagnosticsBundle({ settings, db });
      const json = serializeBundle(bundle);
      return Promise.resolve(okResult({ bundle, json }));
    } catch (err) {
      logger.error(`diagnostics.export failed: ${(err as Error).message}`);
      return Promise.resolve(failResult('diagnostics_export_failed', (err as Error).message));
    }
  });

  // OBS-01 — drive the Save dialog from main because only main has
  // access to the absolute filesystem. The renderer passes a default
  // filename; we open showSaveDialog, then writeFileSync the JSON.
  // Returns the chosen path or null if the user cancelled.
  register('app.diagnostics.saveToFile', async (_e, req) => {
    try {
      const defaultName = (req?.defaultName as string | undefined) ?? 'diagnostics.json';
      const json = (req?.json as string | undefined) ?? '';
      if (!json) {
        return failResult('diagnostics_save_empty', 'json payload is empty');
      }
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const res = await dialog.showSaveDialog(win as never, {
        title: '保存诊断包',
        defaultPath: defaultName,
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (res.canceled || !res.filePath) {
        return okResult({ path: null });
      }
      writeFileSync(res.filePath, json, 'utf8');
      logger.info(`diagnostics: wrote ${json.length} bytes to ${res.filePath}`);
      return okResult({ path: res.filePath });
    } catch (err) {
      logger.error(`diagnostics.saveToFile failed: ${(err as Error).message}`);
      return failResult('diagnostics_save_failed', (err as Error).message);
    }
  });
}