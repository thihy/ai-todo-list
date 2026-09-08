import { describe, it, expect as e, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MarkdownStore } from '../../src/main/files/markdown';

describe('TodoRepo + MarkdownStore', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let md: MarkdownStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thihy-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    md = new MarkdownStore(handle.db, join(dir, 'todos'));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a TODO and reads it back', () => {
    const t = repo.create({ title: 'Test' }, join(dir, 'todos', 'fake.md'));
    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(t.status).toBe('inbox');
    expect(t.title).toBe('Test');
  });

  it('updates fields and tags', () => {
    const t = repo.create({ title: 'A' }, 'x');
    const updated = repo.update(t.id, { status: 'doing', priority: 'high', tags: ['x', 'y'] });
    expect(updated.status).toBe('doing');
    expect(updated.priority).toBe('high');
    expect(updated.tags.sort()).toEqual(['x', 'y']);
  });

  it('lists with filter', () => {
    repo.create({ title: 'A', status: 'inbox' }, 'x');
    repo.create({ title: 'B', status: 'done', priority: 'high' }, 'x');
    const all = repo.list();
    expect(all).toHaveLength(2);
    const inbox = repo.list({ status: ['inbox'] });
    expect(inbox).toHaveLength(1);
  });

  it('search uses FTS', () => {
    const a = repo.create({ title: '登录页设计' }, 'x');
    repo.create({ title: '无关条目' }, 'x');
    const hits = repo.search('登录');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].todo.id).toBe(a.id);
  });

  it('writes markdown body and trims versions to MAX', async () => {
    const t = repo.create({ title: 'MD test' }, 'x');
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = md.writeBody(t.id, `# v${i}`).version;
    }
    const { markdown } = md.readBody(t.id);
    expect(markdown).toContain('v24');
    expect(last).toBeGreaterThanOrEqual(25);
    const hist = md.history(t.id);
    expect(hist.length).toBeLessThanOrEqual(20);
  });

  it('restores a previous version', () => {
    const t = repo.create({ title: 'restore' }, 'x');
    md.writeBody(t.id, 'first');
    md.writeBody(t.id, 'second');
    const hist = md.history(t.id);
    md.restoreVersion(t.id, hist[1].id);
    expect(md.readBody(t.id).markdown).toBe('first');
  });
});