// QUALITY-01 — health check IPC handler.
//
// Single channel `app.health.check` returning a deterministic rule
// report. The renderer subscribes to `app:health-checked` (pushed
// after every mutating IPC) and re-renders without polling.
//
// We deliberately do NOT include AI suggestions here — that's a
// future layer (AI-01 / QUALITY-02). The handler must stay pure
// + deterministic so the renderer can diff reports across time
// and the user can trust the count.

import { okResult, failResult, register } from './router';
import { runHealthRules, type HealthIssue } from '../health/rules';
import { logger } from '../logger';
import type Database from 'better-sqlite3';

export function registerHealthHandlers(db: Database.Database): void {
  register('app.health.check', () => {
    try {
      const issues = runHealthRules(db);
      return Promise.resolve(okResult({ issues, checkedAt: Date.now() }));
    } catch (err) {
      logger.error(`health.check failed: ${(err as Error).message}`);
      return Promise.resolve(failResult('health_check_failed', (err as Error).message));
    }
  });
}

/** Re-export the HealthIssue type so the renderer can import it from
 *  here if it ever needs to (e.g. when building a dedicated
 *  /health route). The IPC schema's mirror is the canonical one for
 *  IPC contracts — see shared/ipc-schema.ts. */
export type { HealthIssue };