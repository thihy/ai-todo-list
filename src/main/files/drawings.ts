// Drawings are files, with opaque references derived from task id + exact filename.
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DrawingMeta, ULID } from '../../shared/todo-types';
import { allocateFileName, drawingFileName } from './paths';
import type { TaskFileIndex } from './task-files';
import { assertDrawingScene } from '../../shared/drawing-scene';
import { assertDocumentName } from './documents';
import { drawingFileId } from '../../shared/drawing-file-ref';
export { drawingFileId } from '../../shared/drawing-file-ref';

function decodeId(id: string): { todoId: string; fileName: string } {
  const match = /^file:([^:]+):([^:]+)$/.exec(id);
  if (!match) throw new Error('drawing_not_found: 请重新获取 drawing_list 中的文件引用');
  const todoId = decodeURIComponent(match[1]!);
  const fileName = decodeURIComponent(match[2]!);
  assertDocumentName(fileName);
  if (!fileName.toLowerCase().endsWith('.excalidraw')) throw new Error('invalid_drawing_file');
  return { todoId, fileName };
}
export class DrawingStore {
  constructor(_db: Database.Database, private drawingsDir: string,
    private resolveTaskDir: (id: ULID) => string, private files?: TaskFileIndex) {}
  get baseDir(): string { return this.drawingsDir; }
  list(todoId: ULID): DrawingMeta[] {
    const dir = this.resolveTaskDir(todoId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && !f.name.startsWith('.') && f.name.toLowerCase().endsWith('.excalidraw'))
      .map((f) => this.meta(todoId, f.name))
      .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'zh-Hans-CN'));
  }
  private thumbName(id: string): string {
    return createHash('sha256').update(id).digest('hex');
  }
  private meta(todoId: string, fileName: string): DrawingMeta {
    const id = drawingFileId(todoId, fileName);
    const dir = this.resolveTaskDir(todoId);
    const stat = statSync(join(dir, fileName));
    const thumb = 'thumbs/' + this.thumbName(id) + '.thumb.png';
    return { id, todoId, fileName, title: fileName.slice(0, -11),
      thumbPath: existsSync(join(dir, thumb)) ? thumb : null,
      createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs };
  }
  get(id: ULID): DrawingMeta | null {
    const { todoId, fileName } = decodeId(id);
    if (!existsSync(join(this.resolveTaskDir(todoId), fileName))) return null;
    return this.meta(todoId, fileName);
  }
  read(id: ULID): unknown {
    const { todoId, fileName } = decodeId(id);
    return JSON.parse(readFileSync(join(this.resolveTaskDir(todoId), fileName), 'utf8'));
  }
  save(todoId: ULID, scene: unknown, id?: ULID, title?: string): DrawingMeta {
    assertDrawingScene(scene);
    const dir = this.resolveTaskDir(todoId);
    mkdirSync(dir, { recursive: true });
    let fileName: string;
    if (id) {
      const ref = decodeId(id);
      if (ref.todoId !== todoId) throw new Error('drawing_task_mismatch');
      if (!this.get(id)) throw new Error('drawing_not_found: ' + id);
      fileName = ref.fileName;
      if (title !== undefined && title !== fileName.slice(0, -11)) {
        fileName = this.rename(id, title)!.fileName!;
      }
    } else {
      fileName = allocateFileName(dir, drawingFileName(title), new Set(this.list(todoId).map((f) => f.fileName!)));
    }
    writeFileSync(join(dir, fileName), JSON.stringify(scene), { encoding: 'utf8', flag: id ? 'w' : 'wx' });
    this.files?.invalidate(dir);
    return this.meta(todoId, fileName);
  }
  delete(id: ULID): void {
    const { todoId, fileName } = decodeId(id);
    const dir = this.resolveTaskDir(todoId);
    unlinkSync(join(dir, fileName));
    for (const suffix of ['.thumb.png', '.render.png']) {
      const path = join(dir, 'thumbs', this.thumbName(id) + suffix);
      if (existsSync(path)) unlinkSync(path);
    }
    this.files?.invalidate(dir);
  }
  rename(id: ULID, title: string): DrawingMeta | null {
    const { todoId, fileName } = decodeId(id);
    const dir = this.resolveTaskDir(todoId);
    if (!this.get(id)) return null;
    const names = new Set(this.list(todoId).map((f) => f.fileName!));
    names.delete(fileName);
    const target = allocateFileName(dir, drawingFileName(title), names, fileName);
    if (target !== fileName) {
      try { renameSync(join(dir, fileName), join(dir, target)); }
      catch { return this.meta(todoId, fileName); }
      const newId = drawingFileId(todoId, target);
      for (const suffix of ['.thumb.png', '.render.png']) {
        const old = join(dir, 'thumbs', this.thumbName(id) + suffix);
        if (existsSync(old)) {
          try { renameSync(old, join(dir, 'thumbs', this.thumbName(newId) + suffix)); } catch { /* derived preview */ }
        }
      }
    }
    this.files?.invalidate(dir);
    return this.meta(todoId, target);
  }
  setThumb(id: ULID, dataUrl: string): void {
    if (!this.get(id)) throw new Error('drawing_not_found');
    if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('invalid_thumbnail');
    const { todoId } = decodeId(id);
    const dir = join(this.resolveTaskDir(todoId), 'thumbs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, this.thumbName(id) + '.thumb.png'), Buffer.from(dataUrl.slice(22), 'base64'));
  }
  saveRender(id: ULID, png: Uint8Array): string {
    if (!this.get(id)) throw new Error('drawing_not_found');
    if (png.byteLength > 20 * 1024 * 1024 || Buffer.from(png.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('绘图导出不是有效的 PNG，或图片超过 20 MB。');
    const { todoId } = decodeId(id);
    const dir = join(this.resolveTaskDir(todoId), 'thumbs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, this.thumbName(id) + '.render.png');
    writeFileSync(path, png);
    return path;
  }
}
