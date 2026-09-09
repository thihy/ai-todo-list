// DocumentStore + schema v11 migration tests. Locks the multi-document
// workspace model: every task gets a default progress doc; the legacy .md
// body migrates into a note_md doc with its full version history preserved;
// create/read/write/rename/remove + version trim behave like MarkdownStore.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MarkdownStore } from '../../src/main/files/markdown';
import { DocumentStore } from '../../src/main/files/documents';

describe('DocumentStore + v11 migration', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let md: MarkdownStore;
  let docs: DocumentStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thihy-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    md = new MarkdownStore(handle.db, join(dir, 'todos'));
    docs = new DocumentStore(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureDefaultDocs creates a progress doc for a new task', () => {
    const t = repo.create({ title: 'T' }, 'x');
    docs.ensureDefaultDocs(t.id);
    const list = docs.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('progress');
    expect(list[0]!.ord).toBe(0);
  });

  it('surfaces a legacy .md body as a note_md doc with history', () => {
    // A todo created AFTER the v11 migration still wrote its body via
    // MarkdownStore (content_versions). ensureDefaultDocs must bridge that
    // legacy body into a note_md doc so it's visible in the workspace.
    const t = repo.create({ title: 'Has Notes' }, 'x');
    md.writeBody(t.id, '# v1\nfirst');
    md.writeBody(t.id, '# v2\nsecond');

    docs.ensureDefaultDocs(t.id);
    const list = docs.list(t.id);
    const note = list.find((d) => d.kind === 'note_md');
    expect(note).toBeTruthy();
    // The latest content is the last-written body.
    const read = docs.read(note!.id);
    expect(read.content).toBe('# v2\nsecond');
    // Full history preserved (2 versions).
    expect(docs.history(note!.id)).toHaveLength(2);
  });

  it('write appends a version and trims to MAX_BODY_VERSIONS', () => {
    const t = repo.create({ title: 'T' }, 'x');
    docs.ensureDefaultDocs(t.id);
    const prog = docs.list(t.id).find((d) => d.kind === 'progress')!;
    for (let i = 0; i < 25; i++) docs.write(prog.id, `v${i}`);
    // MAX_BODY_VERSIONS = 20
    expect(docs.history(prog.id).length).toBeLessThanOrEqual(20);
    // Latest content is the last write.
    expect(docs.read(prog.id).content).toBe('v24');
  });

  it('version conflict is detected on concurrent writes', () => {
    const t = repo.create({ title: 'T' }, 'x');
    docs.ensureDefaultDocs(t.id);
    const prog = docs.list(t.id).find((d) => d.kind === 'progress')!;
    const v0 = docs.read(prog.id).version; // 0 (empty)
    docs.write(prog.id, 'a', v0);
    expect(() => docs.write(prog.id, 'b', v0)).toThrow(/version_conflict/);
  });

  it('create/remove/rename manage list metadata across kinds', () => {
    const t = repo.create({ title: 'T' }, 'x');
    docs.ensureDefaultDocs(t.id);
    const link = docs.create(t.id, 'link', 'Google', { url: 'https://google.com' });
    expect(link.kind).toBe('link');
    expect(link.url).toBe('https://google.com');
    const renamed = (docs.rename(link.id, 'G'), docs.get(link.id)!);
    expect(renamed.title).toBe('G');
    docs.remove(link.id);
    expect(docs.get(link.id)).toBeNull();
  });
});
