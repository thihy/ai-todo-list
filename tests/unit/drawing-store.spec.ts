// DrawingStore tests — per-task layout (post-refactor):
// {todosDir}/{slug}/{titleSlug}.excalidraw + thumbs/{id}.thumb.png
//
// 磁盘文件名由 DB 的 drawings.path 登记的映射决定（默认标签「绘图」），
// 不再由「当前标题」反推 —— 见 drawings.ts 顶部注释。
//
// Path-resolution quirk: paths.todoDir() appends a ULID suffix to the dir
// name when the base dir already exists. The DrawingStore caches the taskDir
// internally so reads/writes always hit the same location, but our test
// assertions run outside the store — to assert against the same path the
// store used, we pre-compute via paths.uniqueTodoDir() (no mkdir) before
// the first store call, then reuse that captured value.

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

  /** DB 里登记的映射关系（任务目录相对的文件名）—— 磁盘位置以它为准。 */
  const dbPath = (id: string): string => {
    const row = handle.db
      .prepare<[string], { path: string }>('SELECT path FROM drawings WHERE id = ?')
      .get(id);
    return row?.path ?? '';
  };

  const taskDirOf = (todoId: string): string => {
    const t = repo.get(todoId);
    return paths.uniqueTodoDir(todosDir, paths.slugify(t?.title ?? 'T'), todoId);
  };

  /** 模拟旧版本留下的行：DB 里登记的文件名 / 标签可能和磁盘对不上。 */
  const seedLegacy = (
    id: string,
    todoId: string,
    title: string | null,
    path: string,
    scene: unknown,
  ): void => {
    handle.db
      .prepare(
        'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, todoId, title, path, 1, 1);
    const dir2 = taskDirOf(todoId);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, path), JSON.stringify(scene), 'utf8');
  };

  it('save writes scene to {taskDir}/{titleSlug}.excalidraw', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const scene = { type: 'excalidraw', elements: [] };
    const meta = drawings.save(t.id, scene, undefined, 'Splash');
    const path = paths.drawingFile(taskDir, 'Splash');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(scene);
    expect(meta.title).toBe('Splash');
    expect(dbPath(meta.id)).toBe('Splash.excalidraw');
  });

  it('新建绘图默认落到 绘图.excalidraw，不再是 untitled.excalidraw', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { elements: [] });
    expect(meta.title).toBe('绘图');
    expect(dbPath(meta.id)).toBe('绘图.excalidraw');
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(true);
    expect(existsSync(join(taskDir, 'untitled.excalidraw'))).toBe(false);
  });

  it('第二张绘图拿到 绘图 2，文件名仍是标签的 slug', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const first = drawings.save(t.id, { n: 1 });
    const second = drawings.save(t.id, { n: 2 });
    expect(first.title).toBe('绘图');
    expect(second.title).toBe('绘图 2');
    expect(dbPath(first.id)).toBe('绘图.excalidraw');
    expect(dbPath(second.id)).toBe('绘图_2.excalidraw');
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(true);
    expect(existsSync(join(taskDir, '绘图_2.excalidraw'))).toBe(true);
    expect(drawings.read(first.id)).toEqual({ n: 1 });
    expect(drawings.read(second.id)).toEqual({ n: 2 });
  });

  it('自动保存（不带 title）保留标签与文件名，不再退化成 untitled', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { n: 0 });
    // 画布自动保存：只回写 scene，不带 title（ExcalidrawEditor 的调用方式）
    const after = drawings.save(t.id, { n: 1 }, meta.id);
    expect(after.title).toBe('绘图');
    expect(dbPath(meta.id)).toBe('绘图.excalidraw');
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(true);
    expect(existsSync(join(taskDir, 'untitled.excalidraw'))).toBe(false);
    expect(drawings.read(meta.id)).toEqual({ n: 1 });
  });

  it('带 title 保存同样走改名路径，文件名与标签一起移动', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { n: 0 });
    const after = drawings.save(t.id, { n: 2 }, meta.id, '流程图');
    expect(after.title).toBe('流程图');
    expect(existsSync(join(taskDir, '流程图.excalidraw'))).toBe(true);
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(false);
    expect(dbPath(meta.id)).toBe('流程图.excalidraw');
    expect(drawings.read(meta.id)).toEqual({ n: 2 });
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
    expect(dbPath(meta.id)).toBe('New.excalidraw');
    expect(drawings.read(meta.id)).toEqual({ x: 1 });
  });

  it('改名撞上另一张绘图时各自独立留文件，不覆盖对方内容', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const a = drawings.save(t.id, { who: 'a' }, undefined, 'A');
    const b = drawings.save(t.id, { who: 'b' }, undefined, 'B');
    drawings.rename(a.id, 'B');
    expect(dbPath(a.id)).not.toBe(dbPath(b.id));
    expect(existsSync(join(taskDir, 'B.excalidraw'))).toBe(true);
    expect(drawings.read(b.id)).toEqual({ who: 'b' });
    expect(drawings.read(a.id)).toEqual({ who: 'a' });
  });

  it('同一标签反复保存不会每次都换文件名', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const meta = drawings.save(t.id, { n: 0 }, undefined, '图');
    const before = dbPath(meta.id);
    drawings.save(t.id, { n: 1 }, meta.id, '图');
    drawings.save(t.id, { n: 2 }, meta.id, '图');
    expect(dbPath(meta.id)).toBe(before);
    expect(drawings.read(meta.id)).toEqual({ n: 2 });
    expect(existsSync(join(taskDir, '图.excalidraw'))).toBe(true);
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

  it('delete cleans up the legacy untitled file left by older versions', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    // 映射已经指向 绘图.excalidraw，但磁盘上还留着旧版留下的 untitled 文件
    seedLegacy('D1', t.id, null, '绘图.excalidraw', { x: 1 });
    writeFileSync(join(taskDir, 'untitled.excalidraw'), JSON.stringify({ x: 1 }), 'utf8');
    drawings.delete('D1');
    expect(drawings.get('D1')).toBeNull();
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(false);
    expect(existsSync(join(taskDir, 'untitled.excalidraw'))).toBe(false);
  });

  it('read 认领磁盘上真实存在的旧文件（DB path 指向已不存在的文件）', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    seedLegacy('D1', t.id, '架构图', '缺失的名字.excalidraw', { n: 1 });
    // 旧版本把文件放在按标题算出的位置，DB 里登记的名字却对不上
    rmSync(join(taskDir, '缺失的名字.excalidraw'));
    writeFileSync(join(taskDir, '架构图.excalidraw'), JSON.stringify({ n: 1 }), 'utf8');
    expect(drawings.read('D1')).toEqual({ n: 1 });
    expect(dbPath('D1')).toBe('架构图.excalidraw');
  });

  // --- 历史数据修复 ------------------------------------------------------

  it('repairFilePaths: untitled.excalidraw 回到 绘图.excalidraw 并写回映射', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    seedLegacy('D1', t.id, null, 'untitled.excalidraw', { n: 1 });
    drawings.repairFilePaths();
    expect(dbPath('D1')).toBe('绘图.excalidraw');
    expect(existsSync(join(taskDir, '绘图.excalidraw'))).toBe(true);
    expect(existsSync(join(taskDir, 'untitled.excalidraw'))).toBe(false);
    expect(drawings.get('D1')!.title).toBe('绘图');
    expect(drawings.read('D1')).toEqual({ n: 1 });
  });

  it('repairFilePaths: 标签改名后文件名没跟上的老数据被拉齐', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    seedLegacy('D1', t.id, '架构图', 'untitled.excalidraw', { n: 1 });
    drawings.repairFilePaths();
    expect(dbPath('D1')).toBe('架构图.excalidraw');
    expect(existsSync(join(taskDir, '架构图.excalidraw'))).toBe(true);
    expect(drawings.read('D1')).toEqual({ n: 1 });
  });

  it('repairFilePaths: 多行共用一个文件时拆成各自独立文件', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    // 旧版本的自动保存把所有绘图都写进同一个 untitled.excalidraw
    seedLegacy('D1', t.id, null, 'untitled.excalidraw', { n: 1 });
    seedLegacy('D2', t.id, null, 'untitled.excalidraw', { n: 2 });
    drawings.repairFilePaths();
    // 关键保证：两行各自指向自己的文件，之后互不覆盖。
    // 内容都等于共享文件里幸存的最后一份 —— 旧版本互相覆盖时 D1 的原始
    // 内容就已经丢了，修复没法凭空造回来。
    expect(dbPath('D1')).not.toBe(dbPath('D2'));
    for (const id of ['D1', 'D2']) {
      expect(existsSync(join(taskDir, dbPath(id)))).toBe(true);
    }
    expect(drawings.read('D1')).toEqual({ n: 2 });
    expect(drawings.read('D2')).toEqual({ n: 2 });
    // 拆完之后再写，两边不再互相踩
    drawings.save(t.id, { n: 'D1-new' }, 'D1');
    expect(drawings.read('D1')).toEqual({ n: 'D1-new' });
    expect(drawings.read('D2')).toEqual({ n: 2 });
  });

  it('repairFilePaths: 幂等 —— 对齐完成后重复调用不再写盘', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    seedLegacy('D1', t.id, null, 'untitled.excalidraw', { n: 1 });
    drawings.repairFilePaths();
    const first = dbPath('D1');
    const scene = drawings.read('D1');
    drawings.repairFilePaths();
    expect(dbPath('D1')).toBe(first);
    expect(drawings.read('D1')).toEqual(scene);
    expect(existsSync(join(taskDir, first))).toBe(true);
  });
});