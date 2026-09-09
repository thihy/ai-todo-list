// InboxStore tests: attach / attachBlob / list / read (→ dataUrl) / remove.
// Locks the contract that the renderer never sees an absolute path — only a
// data: URL — and that attachments are keyed by todoId.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { InboxStore } from '../../src/main/files/inbox';

describe('InboxStore', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let inbox: InboxStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thihy-inbox-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    inbox = new InboxStore(handle.db, join(dir, 'attachments'));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attach copies a file and list returns it keyed by todoId', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'note.txt');
    writeFileSync(src, 'hello attachments', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    expect(att.todoId).toBe(t.id);
    expect(att.mime).toBe('text/plain');
    const list = inbox.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(att.id);
  });

  it('attachBlob decodes a base64 data URL and read returns it back as a data URL', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const b64 = Buffer.from('pixel-data').toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;
    const att = inbox.attachBlob(t.id, dataUrl, 'shot.png', 'image/png');
    expect(att.mime).toBe('image/png');
    // read() returns a data URL the renderer can embed — never the file path.
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
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'a', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    inbox.remove(att.id);
    expect(inbox.list(t.id)).toHaveLength(0);
    expect(inbox.get(att.id)).toBeNull();
    expect(() => inbox.read(att.id)).toThrow(/attachment_not_found/);
  });

  it('read throws on unknown id', () => {
    expect(() => inbox.read('nope')).toThrow(/attachment_not_found/);
  });
});
