// IPC handlers for the "current app focus" pointer and the "open task dir"
// affordance. Pure delegation to the singletons in main/app-context.ts and
// the on-disk layout in main/index.ts (we receive the directory handles via
// closures — see registerAppHandlers below).

import { shell } from 'electron';
import { okResult, failResult, register } from './router';
import { getFocus, setFocus } from '../app-context';
import { logger } from '../logger';

export interface AppHandlersDeps {
  /** Per-task directory (e.g. <rootDir>/todos/<todoId>). Resolved at
   *  register-time so we don't have to thread the dataDir through every call. */
  resolveTaskDir: (todoId: string) => string;
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
    try {
      const dir = deps.resolveTaskDir(req.todoId);
      const err = await shell.openPath(dir);
      if (err) {
        // shell.openPath returns a non-empty string with an error message
        // when the path doesn't exist or couldn't be opened; surface it
        // instead of silently succeeding.
        return failResult('open_failed', err);
      }
      return okResult({ path: dir });
    } catch (err) {
      return failResult('open_failed', (err as Error).message);
    }
  });

  logger.info('App handlers registered (focus + openTaskDir)');
}