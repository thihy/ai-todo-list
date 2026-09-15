// Quick verification: priority update flow through TodoRepo.update() persists
// every 5-tier priority value, including the extreme values (very-low /
// very-high) the user reported as "not persisting".
//
// Uses an in-process better-sqlite3 (same code path the production main process
// uses), without needing IPC/Electron. If this passes, the DB layer is fine
// and any "didn't persist" symptom must come from the UI layer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { PRIORITIES } from '../../src/shared/todo-types';

describe('TodoRepo.update priority persistence', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-prio-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const p of PRIORITIES) {
    it(`persists priority=${p}`, () => {
      const t = repo.create({ title: 'T', priority: 'medium' }, 'x');
      const updated = repo.update(t.id, { priority: p });
      expect(updated.priority).toBe(p);

      // Also confirm by re-reading via repo.get (separate query, no cache).
      const fresh = repo.get(t.id);
      expect(fresh?.priority).toBe(p);
    });
  }
});