// Minimal logger. Writes to main console + (optionally) a file under userData.

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Path of the rotating single-file log under Electron's per-user data dir.
// Exported so other modules (diagnostics bundle, the "open log dir" affordance)
// can reuse the same string instead of hard-coding it. `getPath('userData')`
// is sync and available as soon as `app` has been imported; we resolve it
// lazily inside `ensurePath()` to keep the module import order flexible.
export const LOG_PATH = join(app.getPath('userData'), 'todo-list.log');
export const LOG_DIR = dirname(LOG_PATH);

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
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      this.logPath = LOG_PATH;
      return LOG_PATH;
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