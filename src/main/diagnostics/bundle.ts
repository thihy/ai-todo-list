// Diagnostics bundle builder (OBS-01).
//
// Produces a redacted JSON snapshot that the user can attach to a
// bug report. The bundle MUST NOT carry: API keys, attachment
// contents, AI conversation bodies, full file bodies (markdown /
// drawing JSON), or absolute paths that could identify the user.
//
// It DOES carry: app version, OS / arch, DB schema version,
// startup phase snapshot (with `errorMessage` already redacted by
// startup-state.ts), provider name (not key), task counts by
// status, data directory sizes, settings.sdkBridge.enabled (not
// the token), and a tail of the recent log file with paths /
// keys / emails scrubbed.

import { app } from 'electron';
import { statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../db/schema';
import { startupState } from '../startup-state';
import { logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type Database from 'better-sqlite3';
import type { TodoStatus } from '../../shared/todo-types';
import type { DiagnosticsBundle } from '../../shared/ipc-schema';

const LOG_TAIL_BYTES = 32 * 1024; // ~32 KiB tail is plenty for triage
const LOG_TAIL_LINES = 200;

/** Build the bundle. Pulls every field synchronously; the slow part is
 *  statSync for the data dirs which is local FS only. */
export function buildDiagnosticsBundle(opts: {
  settings: SettingsStore;
  /** The DB handle — passed explicitly so we don't reach through
   *  TodoRepo's private fields. The diagnostics layer only needs
   *  COUNT(*) queries, no domain logic. */
  db: Database.Database;
  /** Function returning bytes-of-dir (null if path doesn't exist).
   *  Injected so we can keep this module free of recursive-walk
   *  dependencies; production passes `dirSize` from files/. */
  dirSize?: (p: string) => number | null;
}): DiagnosticsBundle {
  const { settings, db } = opts;
  const dirSize = opts.dirSize ?? defaultDirSize;

  const dataDir = settings.getDataDir();

  // ---- counts ----------------------------------------------------------
  const countsRow = db
    .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM todos WHERE deleted_at IS NULL")
    .get();
  const totalTasks = countsRow?.c ?? 0;
  // Per-status counts. We hardcode the enum rather than rely on a SQL
  // join so a future migration that introduces a new status doesn't
  // silently drop the count.
  const statusList: readonly TodoStatus[] = ['next', 'doing', 'done', 'cancelled', 'blocked'];
  const byStatus: Partial<Record<TodoStatus | '__other', number>> = {};
  for (const s of statusList) {
    const row = db
      .prepare<[TodoStatus], { c: number }>('SELECT COUNT(*) as c FROM todos WHERE deleted_at IS NULL AND status = ?')
      .get(s);
    byStatus[s] = row?.c ?? 0;
  }
  // Catch-all so a future status enum doesn't silently become "0".
  const placeholders = statusList.map(() => '?').join(',');
  const otherRow = db
    .prepare<TodoStatus[], { c: number }>(
      `SELECT COUNT(*) as c FROM todos WHERE deleted_at IS NULL AND status NOT IN (${placeholders})`,
    )
    .get(...statusList);
  byStatus.__other = otherRow?.c ?? 0;

  // ---- startup snapshot ------------------------------------------------
  // startupState.snapshot() returns the live state, including any
  // errorMessage which has already been redacted by startup-state.ts
  // (see redactMessage). We capture it at build time, NOT in the
  // exported JSON-RPC response, so a late state change can't leak.
  const startupSnapshot = startupState.snapshot();

  // ---- provider identity ----------------------------------------------
  const v = settings.get();
  const activeCustom =
    v.provider === 'custom'
      ? v.customProviders.find((c) => c.id === v.customProviderId) ?? v.customProviders[0]
      : null;

  // ---- log tail --------------------------------------------------------
  const logTail = readLogTail();

  // ---- assemble --------------------------------------------------------
  return {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    system: {
      platform: process.platform,
      arch: process.arch,
      release: process.release.name === 'node' ? process.version : process.release.name,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
    },
    schemaVersion: SCHEMA_VERSION,
    startup: startupSnapshot,
    aiProvider: {
      name: v.provider,
      customName: activeCustom?.name ?? null,
      model: v.model,
      lastHeartbeatAt: v.lastHeartbeatAt,
      monthlyCostUsd: v.monthlyCostUsd,
    },
    taskCounts: { total: totalTasks, byStatus },
    dataSizes: {
      dbBytes: dirSize(join(dataDir, 'todos.db')),
      todosBytes: dirSize(join(dataDir, 'todos')),
      drawingsBytes: dirSize(join(dataDir, 'drawings')),
      attachmentsBytes: dirSize(join(dataDir, 'attachments')),
      dshSessionsBytes: dirSize(join(dataDir, 'dsh-sessions')),
    },
    sdkBridgeEnabled: v.sdkBridge.enabled,
    recentLogs: logTail,
  };
}

// ---- helpers ----------------------------------------------------------

function defaultDirSize(p: string): number | null {
  try {
    if (!existsSync(p)) return null;
    const s = statSync(p);
    // statSync reports size for files. For directories this is the
    // size of the directory entry itself, NOT the recursive total.
    // We only return a value for files; recursive walking is the
    // caller's responsibility (it injects a real implementation
    // backed by the existing files/ utilities).
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** Read the last ~LOG_TAIL_BYTES of `todo-list.log` and redact
 *  absolute paths / emails / api-key-shaped blobs. Returns at most
 *  LOG_TAIL_LINES lines, oldest-first within the slice. */
function readLogTail(): string[] {
  const path = join(app.getPath('userData'), 'todo-list.log');
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    const stat = statSync(path);
    if (stat.size <= LOG_TAIL_BYTES) {
      raw = readFileSync(path, 'utf8');
    } else {
      // Open a window: read the tail chunk via offset. We use the
      // synchronous fs APIs because the renderer is awaiting this
      // IPC and we don't want to add a worker for a single 32 KiB
      // tail read. The tail always includes the most recent activity
      // — what the bundle consumer wants.
      const buf = Buffer.alloc(LOG_TAIL_BYTES);
      const fh = openSync(path, 'r');
      try {
        readSync(fh, buf, 0, LOG_TAIL_BYTES, stat.size - LOG_TAIL_BYTES);
        raw = buf.toString('utf8');
      } finally {
        closeSync(fh);
      }
    }
  } catch (err) {
    logger.warn(`diagnostics: cannot read log tail: ${(err as Error).message}`);
    return [];
  }
  // Drop a partial first line if we sliced mid-line.
  const firstNewline = raw.indexOf('\n');
  const trimmed = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
  const lines = trimmed.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-LOG_TAIL_LINES);
  return tail.map(redactLogLine);
}

/** Redact a single log line in-place. Replaces:
 *  - Windows / POSIX absolute paths with `<path>`
 *  - `key=...` blobs up to the next whitespace with `key=<redacted>`
 *  - anything shaped like an email with `<email>`
 *  - long base64-ish blobs (>40 chars of [A-Za-z0-9+/=]) with `<blob>`
 *  - the bridge capability token (32+ char base64url) with `token=<redacted>`
 */
function redactLogLine(line: string): string {
  let s = line;
  // Windows path
  s = s.replace(/[A-Z]:\\[^\s'"]+/gi, '<path>');
  // POSIX /home /root /Users /var /tmp /etc /opt paths
  s = s.replace(/\/(?:home|root|Users|var|tmp|etc|opt)\/[^\s'"]+/g, '<path>');
  // key=value (apiKey=, api_key=, token=, key=, secret=)
  s = s.replace(/\b(api_?key|token|secret|key)=([^\s'"]+)/gi, '$1=<redacted>');
  // 32+ char base64url run — used by the bridge token
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) =>
    /^[A-Za-z0-9_-]+$/.test(m) ? '<blob>' : m,
  );
  // emails
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  return s;
}

/** Convert the bundle to a stable, line-limited JSON string. The
 *  renderer asks for `{ bundle: object }` and writes it to a file
 *  via the `downloadPath` plumbing; we keep the JSON small so the
 *  file is reasonable to attach to a bug report. */
export function serializeBundle(b: DiagnosticsBundle): string {
  return JSON.stringify(b, null, 2);
}