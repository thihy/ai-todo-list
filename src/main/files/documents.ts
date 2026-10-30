// Local files own document names, existence and current content. Git owns history.
import type Database from 'better-sqlite3';
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId } from '../db/schema';
import type { TaskFileEntry, TodoLink, ULID } from '../../shared/todo-types';
import { allocateFileName, DEFAULT_NOTE_TITLE, noteFileName, PROGRESS_FILE_NAME } from './paths';
import { TaskFileIndex } from './task-files';
interface LinkRow {
  id: string;
  todo_id: string;
  title: string | null;
  url: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function rowToLink(row: LinkRow): TodoLink {
  return {
    id: row.id,
    todoId: row.todo_id,
    title: row.title,
    url: row.url,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function fileVersion(content: string): number {
  return parseInt(createHash('sha256').update(content).digest('hex').slice(0, 12), 16);
}
export function assertDocumentName(name: string): void {
  if (!name || basename(name) !== name || /[/\\\\:\x00]/.test(name) || name.startsWith('.') || !/\.(md|excalidraw)$/i.test(name)) {
    throw new Error('仅支持任务目录中的 .md 和 .excalidraw 文件');
  }
}
export class DocumentStore {
  constructor(private db: Database.Database, private files = new TaskFileIndex(),
    private resolveTaskDir?: (id: ULID) => string) {}
  takenNames(dir: string): Set<string> { return this.files.takenNames(dir); }
  listFiles(dir: string): TaskFileEntry[] { return this.files.list(dir); }
  refreshFiles(dir: string): TaskFileEntry[] {
    this.files.invalidate(dir);
    return this.files.list(dir);
  }
  createNoteFile(dir: string, title?: string | null): TaskFileEntry {
    const name = allocateFileName(dir, noteFileName(title?.trim() || DEFAULT_NOTE_TITLE), this.takenNames(dir));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '', { encoding: 'utf8', flag: 'wx' });
    this.files.invalidate(dir);
    return this.files.find(dir, name)!;
  }
  importFiles(dir: string, sources: string[]): TaskFileEntry[] {
    if (!Array.isArray(sources) || !sources.length) throw new Error('请选择本地文档');
    for (const source of sources) {
      assertDocumentName(basename(source));
      if (!statSync(source).isFile()) throw new Error('只能导入文件');
    }
    mkdirSync(dir, { recursive: true });
    const copied: string[] = [];
    try {
      for (const source of sources) {
        const name = allocateFileName(dir, basename(source), this.takenNames(dir));
        copyFileSync(source, join(dir, name), constants.COPYFILE_EXCL);
        copied.push(name);
        this.files.invalidate(dir);
      }
    } catch (error) {
      for (const name of copied) unlinkSync(join(dir, name));
      this.files.invalidate(dir);
      throw error;
    }
    return copied.map((name) => this.files.find(dir, name)!);
  }
  removeFile(dir: string, name: string): void {
    assertDocumentName(name);
    unlinkSync(join(dir, name));
    this.files.invalidate(dir);
  }
  renameFile(dir: string, name: string, title: string): string {
    assertDocumentName(name);
    if (name === PROGRESS_FILE_NAME) return name;
    const taken = this.takenNames(dir);
    taken.delete(name);
    const target = allocateFileName(dir, noteFileName(title), taken, name);
    if (target === name) return name;
    try { renameSync(join(dir, name), join(dir, target)); } catch { return name; }
    this.files.invalidate(dir);
    return target;
  }
  writeToFile(dir: string, name: string, content: string): void {
    assertDocumentName(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
    this.files.invalidate(dir);
  }
  ensureDefaultDocs(_id: ULID, dir: string): void {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, PROGRESS_FILE_NAME))) {
      writeFileSync(join(dir, PROGRESS_FILE_NAME), '', { encoding: 'utf8', flag: 'wx' });
      this.files.invalidate(dir);
    }
  }
  read(id: ULID, name: string, dir?: string): { content: string; version: number } {
    assertDocumentName(name);
    const directory = dir ?? this.resolveTaskDir?.(id);
    if (!directory) throw new Error('task_directory_required');
    const content = readFileSync(join(directory, name), 'utf8');
    return { content, version: fileVersion(content) };
  }
  saveContent(dir: string, id: ULID, name: string, content: string, expected?: number): { version: number; updatedAt: number } {
    assertDocumentName(name);
    if (expected !== undefined) {
      const current = existsSync(join(dir, name)) ? this.read(id, name, dir).version : 0;
      if (expected !== current) throw new Error(`version_conflict: expected ${expected}, current ${current}`);
    }
    this.writeToFile(dir, name, content);
    const updatedAt = Date.now();
    if (name === PROGRESS_FILE_NAME) this.db.prepare('UPDATE todos SET body = ?, updated_at = ? WHERE id = ?').run(content, updatedAt, id);
    return { version: fileVersion(content), updatedAt };
  }
}

// ----- 链接 -----
//
// 链接不是文档:它没有文件,吃不了「文件名 = 标签」那套规则,所以它有自己
// 的表 todo_links(schema v21 从 task_documents 里搬过来的)。数据模型很简单,
// 没有版本历史 —— 改链接就是改这一行。

export class LinkStore {
  constructor(private db: Database.Database) {}

  /** 按添加顺序(旧 → 新)列出任务的所有链接。 */
  list(todoId: ULID): TodoLink[] {
    return this.db
      .prepare<[ULID], LinkRow>(
        'SELECT id, todo_id, title, url, description, created_at, updated_at FROM todo_links WHERE todo_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(todoId)
      .map(rowToLink);
  }

  get(id: ULID): TodoLink | null {
    const row = this.db
      .prepare<[ULID], LinkRow>(
        'SELECT id, todo_id, title, url, description, created_at, updated_at FROM todo_links WHERE id = ?',
      )
      .get(id);
    return row ? rowToLink(row) : null;
  }

  /** 新增一条链接。url 是唯一必填项 —— 标题缺失时调用方(UI)会退回用
   *  hostname，存进来的一定是可读的名字。 */
  add(
    todoId: ULID,
    url: string,
    title?: string | null,
    description?: string | null,
  ): TodoLink {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO todo_links (id, todo_id, title, url, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, todoId, title ?? null, url, description ?? null, now, now);
    return this.get(id)!;
  }

  remove(id: ULID): void {
    this.db.prepare('DELETE FROM todo_links WHERE id = ?').run(id);
  }
}
