import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { TaskDirectoryStore } from '../../src/main/files/task-directories';
import { DrawingStore } from '../../src/main/files/drawings';
import { TaskFileIndex } from '../../src/main/files/task-files';

describe('filesystem drawings', () => {
 let dir: string; let handle: ReturnType<typeof openDb>; let repo: TodoRepo;
 let directories: TaskDirectoryStore; let store: DrawingStore; let files: TaskFileIndex;
 beforeEach(() => {
   dir = mkdtempSync(join(tmpdir(), 'drawing-files-'));
   handle = openDb(join(dir, 'todos.db'));
   repo = new TodoRepo(handle.db);
   directories = new TaskDirectoryStore(handle.db, join(dir, 'todos'));
   files = new TaskFileIndex();
   store = new DrawingStore(handle.db, join(dir, 'drawings'), (id) => directories.resolve(id), files);
 });
 afterEach(() => { handle.close(); rmSync(dir, { recursive: true, force: true }); });
 it('discovers copied files and always reads disk, including external edits and removals', () => {
   const task = repo.create({ title: '图' });
   const path = directories.resolve(task.id);
   writeFileSync(join(path, '架构 图.excalidraw'), '{"elements":[]}');
   const [drawing] = store.list(task.id);
   expect(drawing!.fileName).toBe('架构 图.excalidraw');
   expect(store.read(drawing!.id)).toEqual({ elements: [] });
   writeFileSync(join(path, drawing!.fileName!), '{"elements":[],"appState":{"viewBackgroundColor":"red"}}');
   expect(store.read(drawing!.id)).toEqual({ elements: [], appState: { viewBackgroundColor: 'red' } });
   expect(store.list(task.id)[0]!.id).toBe(drawing!.id);
   expect(repo.get(task.id)!.drawingIds).toEqual([drawing!.id]);
   unlinkSync(join(path, drawing!.fileName!));
   expect(store.list(task.id)).toEqual([]);
   expect(() => store.read(drawing!.id)).toThrow();
 });
 it('creates collision-free names and autosaves in place without truncating imported filenames', () => {
   const task = repo.create({ title: '任务' });
   const a = store.save(task.id, { elements: [] });
   const b = store.save(task.id, { elements: [] });
   expect(a.fileName).toBe('绘图.excalidraw');
   expect(b.fileName).toBe('绘图_1.excalidraw');
   const path = directories.resolve(task.id);
   const long = '一个很长的本地文件名 带空格 而且不应该被自动保存修改.excalidraw';
   writeFileSync(join(path, long), '{"elements":[]}');
   const imported = store.list(task.id).find((f) => f.fileName === long)!;
   expect(store.save(task.id, { elements: [], appState: {} }, imported.id).fileName).toBe(long);
   expect(existsSync(join(path, long))).toBe(true);
 });
 it('rename changes file reference, preserves previews and cannot overwrite another scene', () => {
   const task = repo.create({ title: '任务' });
   const a = store.save(task.id, { elements: [] }, undefined, 'A');
   store.setThumb(a.id, 'data:image/png;base64,cG5n');
   const b = store.save(task.id, { elements: [], appState: {} }, undefined, 'B');
   const renamed = store.rename(a.id, 'B')!;
   expect(renamed.fileName).toBe('B_1.excalidraw');
   expect(renamed.id).not.toBe(a.id);
   expect(store.get(a.id)).toBeNull();
   expect(renamed.thumbPath).not.toBeNull();
   expect(store.read(b.id)).toEqual({ elements: [], appState: {} });
   store.delete(renamed.id);
   expect(store.list(task.id)).toHaveLength(1);
 });
 it('file references survive task directory moves and external drawing renames appear immediately', () => {
   const task = repo.create({ title: '原任务' });
   const drawing = store.save(task.id, { elements: [] });
   const moved = directories.rename(task.id, '新任务');
   expect(moved.dirRenamed).toBe(true);
   expect(store.read(drawing.id)).toEqual({ elements: [] });
   renameSync(join(moved.newDir, drawing.fileName!), join(moved.newDir, '外部改名.excalidraw'));
   expect(store.list(task.id)[0]!.title).toBe('外部改名');
   expect(store.get(drawing.id)).toBeNull();
 });
 it('rejects traversal and cross-task writes and leaves invalid files intact for diagnosis', () => {
   const a = repo.create({ title: 'A' }); const b = repo.create({ title: 'B' });
   const drawing = store.save(a.id, { elements: [] });
   expect(() => store.save(b.id, {}, drawing.id)).toThrow(/mismatch/);
   expect(() => store.read('file:' + a.id + ':%2E%2E%2Fbad.excalidraw')).toThrow();
   const path = directories.resolve(a.id);
   writeFileSync(join(path, 'broken.excalidraw'), 'invalid');
   expect(store.list(a.id)).toHaveLength(2);
   const bad = store.list(a.id).find((f) => f.title === 'broken')!;
   expect(() => store.read(bad.id)).toThrow();
   expect(readFileSync(join(path, 'broken.excalidraw'), 'utf8')).toBe('invalid');
 });
 it('does not recreate a file removed by another app during autosave', () => {
   const task = repo.create({ title: 'A' }); const drawing = store.save(task.id, {});
   unlinkSync(join(directories.resolve(task.id), drawing.fileName!));
   expect(() => store.save(task.id, {}, drawing.id)).toThrow(/not_found/);
 });
});
