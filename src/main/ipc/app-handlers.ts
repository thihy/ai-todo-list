// IPC handlers for the "current app focus" pointer and the "open task dir"
// affordance. Pure delegation to the singletons in main/app-context.ts and
// the on-disk layout in main/index.ts (we receive the directory handles via
// closures — see registerAppHandlers below).

import { existsSync } from 'node:fs';
import { shell } from 'electron';
import { okResult, failResult, register } from './router';
import { getFocus, setFocus } from '../app-context';
import { logger } from '../logger';

export interface AppHandlersDeps {
  /** Resolve the per-task directory for a given TODO id. Post-refactor every
   *  task has its own folder (dataDir/todos/{slug}/); the affordance opens
   *  that folder directly so the user sees all the task's files together. */
  resolveTaskDir: (todoId: string) => string;
  /** Fallback parent when the per-task dir doesn't exist yet (e.g. a brand-
   *  new task that hasn't been touched on disk). We open the todos/ root so
   *  the user lands somewhere sensible instead of getting a silent no-op. */
  todosDir: string;
}

export function registerAppFocusHandlers(deps: AppHandlersDeps): void {
  register('app.focus.set', (_e, req) => {
    try {
      // The renderer's payload uses string, the singleton uses ULID. They're
      // structurally identical (just a brand); the cast is safe at the IPC
      // boundary where branding was already lost.
      setFocus(req.focus as never);
      return Promise.resolve(okResult(undefined));
    } catch (err) {
      return Promise.resolve(failResult('focus_set_failed', (err as Error).message));
    }
  });

  register('app.focus.get', () => {
    try {
      return Promise.resolve(okResult(getFocus() as never));
    } catch (err) {
      return Promise.resolve(failResult('focus_get_failed', (err as Error).message));
    }
  });

  register('app.openTaskDir', async (_e, req) => {
    const taskDir = deps.resolveTaskDir(req.todoId);
    const target = existsSync(taskDir) ? taskDir : deps.todosDir;
    try {
      const errMsg = await shell.openPath(target);
      if (errMsg) {
        // Surface the offending path in the error so the user can tell at
        // a glance whether the taskDir or the todosDir fallback failed —
        // a missing-permission on the task dir is a different problem from
        // a missing-permission on the root.
        const message = `Failed to open path: ${target} (${errMsg})`;
        logger.warn(`openTaskDir: ${message}`);
        return failResult('open_failed', message);
      }
      return okResult({ path: target, dir: taskDir });
    } catch (err) {
      const message = `Failed to open path: ${target} (${(err as Error).message})`;
      logger.warn(`openTaskDir: ${message}`);
      return failResult('open_failed', message);
    }
  });

  logger.info('App handlers registered (focus + openTaskDir)');
}
