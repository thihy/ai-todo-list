// InboxStore tests: attach / attachBlob / list / read (→ dataUrl) / remove.
// Locks the contract that the renderer never sees an absolute path — only a
// data: URL — and that attachments are keyed by todoId.
//
// Per-task layout (post-refactor): files live under
// {todosDir}/{slug}/attachments/. We pre-compute the taskDir via
// paths.uniqueTodoDir (no mkdir) so test assertions and store calls share
// the same path string.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { InboxStore } from '../../src/main/files/inbox';
import * as paths from '../../src/main/files/paths';

describe('InboxStore per-task layout', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let inbox: InboxStore;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-inbox-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
    inbox = new InboxStore(
      handle.db,
      join(dir, 'attachments'),
      todosDir,
      (id) => {
        const t = repo.get(id);
        return paths.todoDir(todosDir, (t?.title as string | undefined) ?? paths.UNTITLED_SLUG, id);
      },
    );
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attach copies a file into {taskDir}/attachments/ and list returns it keyed by todoId', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const src = join(dir, 'note.txt');
    writeFileSync(src, 'hello attachments', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    expect(att.todoId).toBe(t.id);
    expect(att.mime).toBe('text/plain');
    // file lands inside per-task attachments dir
    expect(att.filePath).toContain('attachments');
    expect(att.filePath.startsWith(taskDir)).toBe(true);
    expect(existsSync(att.filePath)).toBe(true);
    const list = inbox.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(att.id);
  });

  it('attachBlob decodes a base64 data URL into {taskDir}/attachments/', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const b64 = Buffer.from('pixel-data').toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;
    const att = inbox.attachBlob(t.id, dataUrl, 'shot.png', 'image/png');
    expect(att.filePath.startsWith(taskDir)).toBe(true);
    expect(existsSync(att.filePath)).toBe(true);
    const read = inbox.read(att.id);
    expect(read.dataUrl).toBe(dataUrl);
    expect(read.mime).toBe('image/png');
    // attachBlob always appends the mime extension (pre-existing behavior),
    // so 'shot.png' → 'shot.png.png' on disk; read() recovers that basename.
    expect(read.filename).toBe('shot.png.png');
    expect(read.dataUrl).not.toContain(dir); // no absolute path leaks
  });

  it('todo.attachmentIds is populated from inbox_attachments (no longer [])', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'a', 'utf8');
    inbox.attach(t.id, src, 'text/plain');
    const fetched = repo.get(t.id);
    expect(fetched!.attachmentIds).toHaveLength(1);
  });

  it('remove deletes the file and the row', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'a', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    const path = att.filePath;
    expect(existsSync(path)).toBe(true);
    inbox.remove(att.id);
    expect(inbox.list(t.id)).toHaveLength(0);
    expect(inbox.get(att.id)).toBeNull();
    expect(() => inbox.read(att.id)).toThrow(/attachment_not_found/);
    // The attachments dir may still exist (empty) but the file is gone.
    expect(existsSync(path)).toBe(false);
    expect(taskDir).toBeTruthy();
  });

  it('read throws on unknown id', () => {
    expect(() => inbox.read('nope')).toThrow(/attachment_not_found/);
  });
});
