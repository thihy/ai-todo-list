import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, LATEST_SCHEMA_VERSION } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { DocumentStore } from '../../src/main/files/documents';

describe('document schema repair', () => {
  it('v24 preserves local edits, exports missing notes and drawings, and drops both tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-files-migrate-'));
    const path = join(dir, 'todos.db');
    let handle = openDb(path);
    const todo = new TodoRepo(handle.db).create({ title: '旧任务' });
    handle.close();
    const db = new Database(path);
    const taskDir = join(dir, 'todos', 'stable-dir');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'progress.md'), '本地最新');
    writeFileSync(join(taskDir, '架构.excalidraw'), '{"elements":[]}');
    db.prepare('UPDATE todos SET storage_dir = ? WHERE id = ?').run('stable-dir', todo.id);
    db.exec(`DELETE FROM schema_meta WHERE version >= 24;
      CREATE TABLE document_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT, file_name TEXT, content TEXT, saved_at INTEGER);
      CREATE TABLE drawings (id TEXT PRIMARY KEY, todo_id TEXT, title TEXT, path TEXT, thumb_path TEXT, created_at INTEGER, updated_at INTEGER);`);
    db.prepare('INSERT INTO document_versions(todo_id, file_name, content, saved_at) VALUES (?, ?, ?, 1)').run(todo.id, 'progress.md', '旧数据库正文');
    db.prepare('INSERT INTO document_versions(todo_id, file_name, content, saved_at) VALUES (?, ?, ?, 1)').run(todo.id, '恢复.md', '仅数据库有');
    db.prepare('INSERT INTO drawings(id, todo_id, title, path) VALUES (?, ?, ?, ?)').run('old-id', todo.id, '架构', '架构.excalidraw');
    db.close();
    try {
      handle = openDb(path);
      expect(readFileSync(join(taskDir, 'progress.md'), 'utf8')).toBe('本地最新');
      expect(readFileSync(join(taskDir, '恢复.md'), 'utf8')).toBe('仅数据库有');
      expect(readFileSync(join(taskDir, '架构.excalidraw'), 'utf8')).toBe('{"elements":[]}');
      expect(handle.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_versions', 'drawings')").all()).toEqual([]);
      const archive = JSON.parse(readFileSync(join(dir, 'migration-backups', 'file-documents-v24.json'), 'utf8'));
      expect(archive.versions).toHaveLength(2);
      handle.close();
      handle = openDb(path);
      expect(readFileSync(join(taskDir, 'progress.md'), 'utf8')).toBe('本地最新');
    } finally { handle.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('修复已标记 v22 的旧文档结构，保留历史和链接，并恢复默认进展及新增文档', () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-document-repair-'));
    const path = join(dir, 'db.sqlite');
    let handle = openDb(path);
    const todo = new TodoRepo(handle.db).create({ title: '旧任务' });
    handle.close();
    const legacy = new Database(path);
    legacy.exec(`
      DELETE FROM schema_meta WHERE version > 20;
      INSERT INTO schema_meta(version) VALUES (21), (22);
      DROP TABLE IF EXISTS document_versions;
      DROP TABLE todo_links;
      CREATE TABLE drawings (id TEXT PRIMARY KEY, todo_id TEXT, title TEXT, path TEXT, thumb_path TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE task_documents (id TEXT PRIMARY KEY, todo_id TEXT, kind TEXT,
        title TEXT, url TEXT, description TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE document_versions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT, content TEXT NOT NULL, saved_at INTEGER NOT NULL);
    `);
    const insert = legacy.prepare('INSERT INTO task_documents VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
    insert.run('progress-id', todo.id, 'progress', '进展', null, null);
    insert.run('note-id', todo.id, 'note_md', '原笔记', null, null);
    insert.run('link-id', todo.id, 'link', '资料', 'https://example.com', '说明');
    const version = legacy.prepare('INSERT INTO document_versions(document_id, content, saved_at) VALUES (?, ?, ?)');
    version.run('progress-id', '第一版', 1);
    version.run('progress-id', '第二版', 2);
    version.run('note-id', '保留笔记内容', 3);
    legacy.close();
    try {
      handle = openDb(path);
      expect(handle.db.prepare('SELECT MAX(version) AS version FROM schema_meta').get()).toEqual({ version: LATEST_SCHEMA_VERSION });
      expect(handle.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_versions', 'drawings')").all()).toEqual([]);
      const migratedDir = join(dir, 'todos', `${todo.id.slice(0, 6)}-旧任务`);
      expect(readFileSync(join(migratedDir, 'progress.md'), 'utf8')).toBe('第二版');
      expect(readFileSync(join(migratedDir, '原笔记.md'), 'utf8')).toBe('保留笔记内容');
      expect(existsSync(join(dir, 'migration-backups', 'file-documents-v24.json'))).toBe(true);
      expect(handle.db.prepare('SELECT id, url FROM todo_links').all()).toEqual([{ id: 'link-id', url: 'https://example.com' }]);
      const docs = new DocumentStore(handle.db);
      const taskDir = join(dir, 'todos', `${todo.id.slice(0, 6)}-旧任务`);
      docs.ensureDefaultDocs(todo.id, taskDir);
      const note = docs.createNoteFile(taskDir, '文档');
      expect(docs.listFiles(taskDir).map((file) => file.fileName)).toEqual(['progress.md', note.fileName, '原笔记.md']);
      docs.saveContent(taskDir, todo.id, note.fileName, '新文档正文');
      expect(docs.read(todo.id, note.fileName, taskDir).content).toBe('新文档正文');
      handle.close();
      handle = openDb(path);
      expect(handle.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_versions', 'drawings')").all()).toEqual([]);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
