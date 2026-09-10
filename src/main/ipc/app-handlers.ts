// IPC handlers for the "current app focus" pointer and the "open task dir"
// affordance. Pure delegation to the singletons in main/app-context.ts and
// the on-disk layout in main/index.ts (we receive the directory handles via
// closures — see registerAppHandlers below).

import { shell } from 'electron';
import { okResult, failResult, register } from './router';
import { getFocus, setFocus } from '../app-context';
import { logger } from '../logger';

export interface AppHandlersDeps {
  /** Absolute path to the task's markdown file (e.g. <rootDir>/todos/<todoId>.md).
   *  Per-task data is stored as a single .md file alongside its siblings in the
   *  shared todos/ directory — there is no per-task directory. We use
   *  shell.showItemInFolder so the OS file manager opens the shared folder
   *  with the task's file highlighted, which is the closest analogue to
   *  "opening the task's folder" without inventing a directory layout that
   *  doesn't exist. */
  resolveTaskFile: (todoId: string) => string;
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
      const filePath = deps.resolveTaskFile(req.todoId);
      // showItemInFolder opens the parent directory in the OS file manager
      // and highlights the file — that is the user-visible "open the
      // task's folder and show me my file" experience even though the
      // storage is a flat file in a shared todos/ directory. It returns
      // void; failures (e.g. path doesn't exist on disk yet) surface as
      // the OS file manager simply not opening, which the user will
      // notice as nothing happening — that's the existing behaviour for
      // shell APIs that can't introspect the file manager's state.
      shell.showItemInFolder(filePath);
      return okResult({ path: filePath });
    } catch (err) {
      return failResult('open_failed', (err as Error).message);
    }
  });

  logger.info('App handlers registered (focus + openTaskDir)');
}