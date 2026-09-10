// migrate-v1-layout tests — locks the v1→v2 layout migration contract.
//
// The sweep runs once per process and is gated by a marker file, so these
// tests exercise the function directly with hand-built v1 fixtures and assert:
//   1. flat {todosDir}/{ulid}.md bodies land in {todosDir}/{slug}/progress.html
//   2. todo.json snapshots are written from the DB row
//   3. drawings/{todoId}/{drawingId}.excalidraw + thumbs move into per-task dirs
//   4. inbox_attachments flat files move + DB file_path rows update
//   5. re-running is a no-op (marker file short-circuits)
//   6. a clean (post-migration) data dir produces zero work but still writes the marker

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { migrateV1Layout } from '../../src/main/files/migrate-v1-layout';
import * as paths from '../../src/main/files/paths';

interface Fixture {
  rootDir: string;
  dataDir: string;
  todosDir: string;
  drawingsDir: string;
  attachmentsDir: string;
  handle: ReturnType<typeof openDb>;
  repo: TodoRepo;
}

function makeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'todo-list-migrate-'));
  const dataDir = rootDir;
  const todosDir = join(rootDir, 'todos');
  const drawingsDir = join(rootDir, 'drawings');
  const attachmentsDir = join(rootDir, 'inbox-attachments');
  mkdirSync(todosDir, { recursive: true });
  mkdirSync(drawingsDir, { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });
  const handle = openDb(join(rootDir, 'db.sqlite'));
  const repo = new TodoRepo(handle.db);
  return { rootDir, dataDir, todosDir, drawingsDir, attachmentsDir, handle, repo };
}

describe('migrateV1Layout', () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });
  afterEach(() => {
    f.handle.close();
    rmSync(f.rootDir, { recursive: true, force: true });
  });

  it('migrates flat {todosDir}/{ulid}.md → {todosDir}/{slug}/progress.html', async () => {
    // v1 fixture: an untitled task with a body file written as `{ulid}.md`.
    const todo = f.repo.create({ title: '工作笔记' }, 'x');
    const legacyBodyPath = join(f.todosDir, `${todo.id}.md`);
    writeFileSync(legacyBodyPath, '<p>hello v1</p>', 'utf8');

    const result = await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });

    expect(result.migrated).toBeGreaterThanOrEqual(1);
    expect(existsSync(legacyBodyPath)).toBe(false);
    // The new task dir uses the slug of the title (no suffix because no
    // collision on first access).
    const newDir = join(f.todosDir, '工作笔记');
    expect(existsSync(join(newDir, 'progress.html'))).toBe(true);
    expect(readFileSync(join(newDir, 'progress.html'), 'utf8')).toBe('<p>hello v1</p>');
  });

  it('writes todo.json from the DB row', async () => {
    const todo = f.repo.create({ title: 'Snap' }, 'x');
    writeFileSync(join(f.todosDir, `${todo.id}.md`), 'body', 'utf8');

    await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });

    const taskDir = join(f.todosDir, paths.slugify('Snap'));
    const json = JSON.parse(readFileSync(paths.todoJsonPath(taskDir), 'utf8'));
    expect(json.id).toBe(todo.id);
    expect(json.title).toBe('Snap');
  });

  it('moves drawings/{todoId}/{drawingId}.excalidraw into per-task dir', async () => {
    const todo = f.repo.create({ title: '画图' }, 'x');
    // Seed a drawing row so the sweep can resolve its title.
    f.handle.db
      .prepare(
        'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('draw1', todo.id, '我的画', '我的画.excalidraw', Date.now(), Date.now());
    const legacy = join(f.drawingsDir, todo.id, 'draw1.excalidraw');
    mkdirSync(join(f.drawingsDir, todo.id), { recursive: true });
    writeFileSync(legacy, '{"elements":[]}', 'utf8');

    await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });

    expect(existsSync(legacy)).toBe(false);
    // Migration writes to the unsuffixed dir on first access; compute the
    // expected path the same way (NOT paths.todoDir, which would suffix
    // now that the dir exists post-migration).
    const newDir = join(f.todosDir, paths.slugify('画图'));
    const moved = paths.drawingFile(newDir, '我的画');
    expect(existsSync(moved)).toBe(true);
  });

  it('moves thumbs into {taskDir}/thumbs/', async () => {
    const todo = f.repo.create({ title: 'ThumbTask' }, 'x');
    f.handle.db
      .prepare(
        'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('draw1', todo.id, null, 'null.excalidraw', Date.now(), Date.now());
    const legacyThumb = join(f.drawingsDir, todo.id, 'draw1.thumb.png');
    mkdirSync(join(f.drawingsDir, todo.id), { recursive: true });
    writeFileSync(legacyThumb, 'png-bytes', 'utf8');

    await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });

    expect(existsSync(legacyThumb)).toBe(false);
    const newDir = join(f.todosDir, paths.slugify('ThumbTask'));
    expect(existsSync(paths.thumbFile(newDir, 'draw1'))).toBe(true);
  });

  it('relocates attachments and rewrites inbox_attachments.file_path', async () => {
    const todo = f.repo.create({ title: 'Attach' }, 'x');
    const legacyAtt = join(f.attachmentsDir, '01abcdef-note.txt');
    writeFileSync(legacyAtt, 'att-data', 'utf8');
    f.handle.db
      .prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('01abcdef', todo.id, legacyAtt, 'text/plain', Date.now());

    await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });

    expect(existsSync(legacyAtt)).toBe(false);
    const newDir = join(f.todosDir, paths.slugify('Attach'));
    const expected = paths.attachmentFile(newDir, '01abcdef-note.txt');
    expect(existsSync(expected)).toBe(true);
    const row = f.handle.db
      .prepare<[string], { file_path: string }>(
        'SELECT file_path FROM inbox_attachments WHERE id = ?',
      )
      .get('01abcdef');
    expect(row!.file_path).toBe(expected);
  });

  it('writes the marker file so re-runs are no-ops', async () => {
    const todo = f.repo.create({ title: 'Once' }, 'x');
    writeFileSync(join(f.todosDir, `${todo.id}.md`), 'body', 'utf8');

    const first = await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });
    expect(first.didWork).toBe(true);

    const second = await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });
    expect(second.migrated).toBe(0);
    expect(second.didWork).toBe(false);
  });

  it('writes the marker file even when no v1 data exists', async () => {
    const result = await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });
    expect(result.migrated).toBe(0);
    expect(result.didWork).toBe(false);
    // Marker should still be present so subsequent boots skip the sweep.
    expect(existsSync(join(f.dataDir, '.layout-migration-v1'))).toBe(true);
  });

  it('skips a task when todo.json already exists at the target dir', async () => {
    const todo = f.repo.create({ title: 'PreMig' }, 'x');
    // Pre-create the destination dir + todo.json so the sweep sees it as
    // already-migrated.
    const targetDir = paths.todoDir(f.todosDir, 'PreMig', todo.id);
    writeFileSync(paths.todoJsonPath(targetDir), '{"id":"x"}', 'utf8');
    writeFileSync(join(f.todosDir, `${todo.id}.md`), 'body', 'utf8');

    const result = await migrateV1Layout({
      dataDir: f.dataDir,
      todosDir: f.todosDir,
      drawingsDir: f.drawingsDir,
      attachmentsDir: f.attachmentsDir,
      db: f.handle.db,
    });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // The pre-existing todo.json must not have been clobbered.
    expect(readFileSync(paths.todoJsonPath(targetDir), 'utf8')).toBe('{"id":"x"}');
  });
});
