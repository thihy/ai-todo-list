// Minimal logger. Writes to main console + (optionally) a file under userData.

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
      const path = join(app.getPath('userData'), 'todo-list.log');
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