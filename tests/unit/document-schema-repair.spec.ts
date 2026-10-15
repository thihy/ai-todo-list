import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, LATEST_SCHEMA_VERSION } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { DocumentStore } from '../../src/main/files/documents';

describe('document schema repair', () => {
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
      DROP TABLE document_versions;
      DROP TABLE todo_links;
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
      expect(handle.db.prepare('SELECT content FROM document_versions WHERE todo_id = ? AND file_name = ? ORDER BY saved_at').all(todo.id, 'progress.md')).toEqual([{ content: '第一版' }, { content: '第二版' }]);
      expect(handle.db.prepare('SELECT content FROM document_versions WHERE file_name = ?').get('原笔记.md')).toEqual({ content: '保留笔记内容' });
      expect(handle.db.prepare('SELECT id, url FROM todo_links').all()).toEqual([{ id: 'link-id', url: 'https://example.com' }]);
      const docs = new DocumentStore(handle.db);
      const taskDir = join(dir, 'task');
      docs.ensureDefaultDocs(todo.id, taskDir);
      const note = docs.createNoteFile(taskDir, '文档');
      expect(docs.listFiles(taskDir).map((file) => file.fileName)).toEqual(['progress.md', note.fileName]);
      docs.saveContent(taskDir, todo.id, note.fileName, '新文档正文');
      expect(docs.read(todo.id, note.fileName).content).toBe('新文档正文');
      handle.close();
      handle = openDb(path);
      expect(handle.db.prepare('SELECT COUNT(*) AS count FROM document_versions').get()).toEqual({ count: 4 });
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
