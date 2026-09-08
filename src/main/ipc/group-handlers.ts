// IPC handlers for group.* channels. Groups are a hand-edited directory tree;
// tasks are "files" filed under a group. See GroupRepo.

import { okResult, failResult, register } from './router';
import type { GroupRepo } from '../db/group-repo';
import { logger } from '../logger';

export function registerGroupHandlers(repo: GroupRepo): void {
  register('group.list', () => {
    try {
      return Promise.resolve(okResult({ groups: repo.list(), counts: repo.counts() }));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('group.create', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.create(req.input.name, req.input.parentId ?? null)));
    } catch (err) {
      return Promise.resolve(failResult('create_failed', (err as Error).message));
    }
  });

  register('group.update', (_e, req) => {
    try {
      return Promise.resolve(okResult(repo.update(req.id, req.patch)));
    } catch (err) {
      return Promise.resolve(failResult('update_failed', (err as Error).message));
    }
  });

  register('group.delete', (_e, req) => {
    try {
      repo.delete(req.id);
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('delete_failed', (err as Error).message));
    }
  });

  logger.info('group.* handlers registered');
}
