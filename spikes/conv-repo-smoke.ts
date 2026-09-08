// Stage L2-A smoke: schema migration v2→v3 + ConversationRepo CRUD.
//
// 1. Create a fresh DB at a temp path (so we get a v2-only schema first via
//    the v1+v2 migrations), then re-open it to trigger the v3 migration.
// 2. Verify conversations table exists, all CRUD ops work, and updated_at
//    bumps on rename/touch.
// 3. Verify archive vs delete semantics: archive hides the row from default
//    list() but it's still in the DB; delete() drops it.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db/schema';
import { ConversationRepo } from '../src/main/db/conversation-repo';

const dir = mkdtempSync(join(tmpdir(), 'thihy-conv-smoke-'));
const dbPath = join(dir, 'smoke.db');
console.log('[conv-smoke] dbPath =', dbPath);

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

try {
  // 1. Fresh open: runs all migrations, ending at v3.
  const handle = openDb(dbPath);
  const db = handle.db;

  // schema_meta should have v3 recorded.
  const metaRow = db
    .prepare('SELECT MAX(version) as v FROM schema_meta')
    .get() as { v: number | null };
  console.log('[conv-smoke] schema version after fresh open:', metaRow.v);
  assert(metaRow.v === 3, `expected schema version 3, got ${metaRow.v}`);

  // conversations table exists.
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
    .get();
  assert(tableRow, 'conversations table missing after migration');
  console.log('[conv-smoke] conversations table present');

  const repo = new ConversationRepo(db);

  // 2. CRUD round-trip.
  const a = repo.create();
  console.log('[conv-smoke] created A:', a.id, a.title);
  assert(a.title.startsWith('新对话'), `default title shape unexpected: ${a.title}`);

  // Wait 5ms so updated_at bumps are observable (Date.now() ms resolution).
  await new Promise((r) => setTimeout(r, 5));
  repo.rename(a.id, '关于 Q3 计划的对话');
  const after = repo.get(a.id);
  assert(after?.title === '关于 Q3 计划的对话', 'rename did not stick');
  assert(after!.updatedAt > a.updatedAt, 'rename did not bump updated_at');
  console.log('[conv-smoke] rename OK, updatedAt bumped');

  await new Promise((r) => setTimeout(r, 5));
  repo.touch(a.id);
  const afterTouch = repo.get(a.id);
  assert(afterTouch!.updatedAt > after!.updatedAt, 'touch did not bump updated_at');
  console.log('[conv-smoke] touch OK');

  // 3. list ordering — create two more, touch them in reverse so the latest
  //    updated lands first.
  await new Promise((r) => setTimeout(r, 5));
  const b = repo.create({ title: '第二个对话' });
  await new Promise((r) => setTimeout(r, 5));
  const c = repo.create({ title: '第三个对话' });
  await new Promise((r) => setTimeout(r, 5));
  repo.touch(b.id); // make b most recent

  const all = repo.list();
  assert(all.length === 3, `expected 3, got ${all.length}`);
  assert(all[0]!.id === b.id, `list[0] should be b (most recent), got ${all[0]!.id}`);
  console.log('[conv-smoke] list ordering OK — b first, then c, then a');

  // 4. archive vs delete.
  const archived = repo.archive(a.id);
  assert(archived, 'archive should return true on success');
  assert(!repo.list().find((r) => r.id === a.id), 'archived row should not appear in default list');
  assert(repo.list(true).find((r) => r.id === a.id), 'archived row should appear with includeArchived');
  console.log('[conv-smoke] archive OK');

  const unarchived = repo.unarchive(a.id);
  assert(unarchived, 'unarchive should return true');
  assert(repo.list().find((r) => r.id === a.id), 'unarchived row should reappear');
  console.log('[conv-smoke] unarchive OK');

  const deleted = repo.delete(c.id);
  assert(deleted, 'delete should return true');
  assert(!repo.get(c.id), 'deleted row should be gone from get');
  assert(!repo.list().find((r) => r.id === c.id), 'deleted row should be gone from list');
  console.log('[conv-smoke] delete OK');

  // 5. Rename rejects empty.
  let threw = false;
  try { repo.rename(b.id, '   '); } catch { threw = true; }
  assert(threw, 'rename with whitespace-only should throw');
  console.log('[conv-smoke] empty-title validation OK');

  handle.close();
  console.log('[conv-smoke] OK');
} catch (err) {
  console.error('[conv-smoke] FAIL:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}