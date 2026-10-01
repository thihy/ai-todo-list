// Minimal logger. Writes to main console + (optionally) a file under userData.

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Path of the rotating single-file log under Electron's per-user data dir.
// Exposed as functions (not consts) so importing this module never touches
// `app`: dozens of main-process modules import the logger at module scope,
// and unit tests import those modules without an Electron instance — an
// eager `app.getPath()` here threw `Cannot read properties of undefined`
// during test collection and took 16 suites with it. Both resolvers return
// null when Electron is unavailable so callers degrade to console-only.
export function logDir(): string | null {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
}

export function logPath(): string | null {
  const dir = logDir();
  return dir === null ? null : join(dir, 'todo-list.log');
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

class Logger {
  private threshold: Level = 'info';
  private logPath: string | null = null;

  setThreshold(level: Level): void {
    this.threshold = level;
  }

  private ensurePath(): string | null {
    if (this.logPath) return this.logPath;
    const path = logPath();
    if (path === null) return null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.logPath = path;
      return path;
    } catch {
      return null;
    }
  }

  private write(level: Level, msg: string): void {
    if (LEVELS[level] < LEVELS[this.threshold]) return;
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase()}] ${msg}\n`;
    // eslint-disable-next-line no-console
    console.log(line.trimEnd());
    const path = this.ensurePath();
    if (path) {
      try {
        appendFileSync(path, line);
      } catch {
        // ignore
      }
    }
  }

  debug(msg: string): void { this.write('debug', msg); }
  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }
}

export const logger = new Logger();