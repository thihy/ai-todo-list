// Regression lock for the lazy log path.
//
// logger.ts used to resolve `app.getPath('userData')` at module scope, so
// importing ANY main-process module that transitively pulls in the logger
// threw `Cannot read properties of undefined (reading 'getPath')` under
// vitest — that single line took 16 suites down at collection time. The
// module's own comment already claimed the path was resolved lazily; this
// spec makes that true and keeps it true.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as loggerModule from '../../src/main/logger';

type LoggerModule = typeof loggerModule;

/** Fresh module graph per scenario — logger caches its resolved path inside
 *  the Logger instance, and the electron mock has to differ per test. */
async function loadLogger(getPath: () => string): Promise<LoggerModule> {
  vi.resetModules();
  vi.doMock('electron', () => ({ app: { getPath } }));
  return import('../../src/main/logger');
}

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('logger log path', () => {
  it('imports and degrades to console-only when Electron is unavailable', async () => {
    const mod = await loadLogger(() => {
      throw new Error('Electron app unavailable');
    });
    expect(mod.logDir()).toBeNull();
    expect(mod.logPath()).toBeNull();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => mod.logger.info('still logs to the console')).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('still logs to the console'));
  });

  it('resolves under userData and writes the log file when Electron is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logger-spec-'));
    try {
      const mod = await loadLogger(() => dir);
      expect(mod.logDir()).toBe(dir);
      expect(mod.logPath()).toBe(join(dir, 'todo-list.log'));

      vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.logger.info('hello from the spec');
      expect(existsSync(join(dir, 'todo-list.log'))).toBe(true);
      expect(readFileSync(join(dir, 'todo-list.log'), 'utf8')).toContain('hello from the spec');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
