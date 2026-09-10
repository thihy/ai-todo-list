// DrawingStore tests — per-task layout (post-refactor):
// {todosDir}/{slug}/{titleSlug}.excalidraw + thumbs/{id}.thumb.png
//
// Path-resolution quirk: paths.todoDir() appends a ULID suffix to the dir
// name when the base dir already exists. The DrawingStore caches the taskDir
// internally so reads/writes always hit the same location, but our test
// assertions run outside the store — to assert against the same path the
// store used, we pre-compute via paths.uniqueTodoDir() (no mkdir) before
// the first store call, then reuse that captured value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { DrawingStore } from '../../src/main/files/drawings';
import * as paths from '../../src/main/files/paths';

describe('DrawingStore per-task layout', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let drawings: DrawingStore;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-draw-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
    drawings = new DrawingStore(handle.db, join(dir, 'drawings'), (id) => {
      const t = repo.get(id);
      return paths.todoDir(todosDir, (t?.title as string | undefined) ?? paths.UNTITLED_SLUG, id);
    });
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('save writes scene to {taskDir}/{titleSlug}.excalidraw', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const scene = { type: 'excalidraw', elements: [] };
    const meta = drawings.save(t.id, scene, undefined, 'Splash');
    const path = paths.drawingFile(taskDir, 'Splash');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(scene);
    expect(meta.title).toBe('Splash');
  });

  it('read parses the JSON scene back', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const scene = { type: 'excalidraw', elements: [{ id: 'a' }] };
    const meta = drawings.save(t.id, scene, undefined, 'Diagram');
    expect(existsSync(paths.drawingFile(taskDir, 'Diagram'))).toBe(true);
    expect(drawings.read(meta.id)).toEqual(scene);
  });

  it('rename moves the on-disk file', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { x: 1 }, undefined, 'Old');
    const oldPath = paths.drawingFile(taskDir, 'Old');
    const newPath = paths.drawingFile(taskDir, 'New');
    expect(existsSync(oldPath)).toBe(true);
    drawings.rename(meta.id, 'New');
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(drawings.get(meta.id)!.title).toBe('New');
  });

  it('setThumb writes to {taskDir}/thumbs/{id}.thumb.png', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { x: 1 }, undefined, 'X');
    // 1x1 transparent PNG (base64).
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    drawings.setThumb(meta.id, dataUrl);
    const path = paths.thumbFile(taskDir, meta.id);
    expect(existsSync(path)).toBe(true);
    expect(drawings.get(meta.id)!.thumbPath).toBe(`thumbs/${meta.id}.thumb.png`);
  });

  it('delete removes the DB row + unlinks scene + thumb', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { x: 1 }, undefined, 'X');
    const scenePath = paths.drawingFile(taskDir, 'X');
    const thumbPath = paths.thumbFile(taskDir, meta.id);
    drawings.setThumb(meta.id, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
    drawings.delete(meta.id);
    expect(drawings.get(meta.id)).toBeNull();
    expect(existsSync(scenePath)).toBe(false);
    expect(existsSync(thumbPath)).toBe(false);
  });
});
