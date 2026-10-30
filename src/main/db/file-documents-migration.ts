// One-time export before removing document state tables. Existing files always win.
import type Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { slugify, drawingFileName } from '../files/paths';

export function migrateFileDocuments(db: Database.Database): void {
  const root = dirname(db.name);
  const todosDir = join(root, 'todos');
  const tasks = db.prepare('SELECT id, title, storage_dir, body FROM todos').all() as Array<{
    id: string; title: string; storage_dir: string | null; body: string;
  }>;
  // Preserve removed DB history for recovery outside the live database.
  const versions = db.prepare('SELECT * FROM document_versions ORDER BY id').all() as Array<{
    id: number; todo_id: string; file_name: string; content: string; saved_at: number;
  }>;
  const drawings = db.prepare('SELECT * FROM drawings').all() as Array<{
    id: string; todo_id: string; title: string | null; path: string; thumb_path: string | null;
  }>;
  if (versions.length || drawings.length) {
    const backupDir = join(root, 'migration-backups');
    mkdirSync(backupDir, { recursive: true });
    // This is an archival export, never read by runtime code.
    writeFileSync(join(backupDir, 'file-documents-v24.json'), JSON.stringify({ versions, drawings }, null, 2), 'utf8');
  }
  for (const task of tasks) {
    const preferred = `${task.id.slice(0, 6)}-${slugify(task.title)}`;
    const candidates = [preferred, slugify(task.title), `${slugify(task.title)}-${task.id.slice(-4)}`];
    const legacy = candidates.find((name) => {
      const dir = join(todosDir, name);
      if (!existsSync(dir)) return false;
      try { const saved = JSON.parse(readFileSync(join(dir, 'todo.json'), 'utf8')); return !saved.id || saved.id === task.id; }
      catch { return true; }
    });
    const name = task.storage_dir ? basename(task.storage_dir) : legacy ?? preferred;
    const dir = join(todosDir, name);
    mkdirSync(dir, { recursive: true });
    db.prepare('UPDATE todos SET storage_dir = ? WHERE id = ?').run(name, task.id);
    const latest = new Map<string, string>();
    for (const version of versions) if (version.todo_id === task.id) latest.set(version.file_name, version.content);
    if (!latest.has('progress.md') && task.body) latest.set('progress.md', task.body);
    for (const [fileName, content] of latest) {
      if (basename(fileName) !== fileName || /[/\\:]/.test(fileName) || !/\.md$/i.test(fileName)) throw new Error('Unsafe legacy document filename');
      const path = join(dir, fileName);
      if (!existsSync(path)) writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const drawing of drawings.filter((row) => row.todo_id === task.id)) {
      const fileName = basename(drawing.path || drawingFileName(drawing.title));
      const target = join(dir, fileName);
      if (!existsSync(target)) {
        const source = [join(dir, drawingFileName(drawing.title)), join(dir, 'untitled.excalidraw'),
          join(root, 'drawings', task.id, `${drawing.id}.excalidraw`)].find(existsSync);
        if (source) copyFileSync(source, target);
      }
      const thumb = drawing.thumb_path ? join(dir, drawing.thumb_path) : join(dir, 'thumbs', `${drawing.id}.thumb.png`);
      if (existsSync(thumb)) {
        const id = 'file:' + encodeURIComponent(task.id) + ':' + encodeURIComponent(fileName);
        const hash = createHash('sha256').update(id).digest('hex');
        mkdirSync(join(dir, 'thumbs'), { recursive: true });
        const dest = join(dir, 'thumbs', hash + '.thumb.png');
        if (!existsSync(dest)) copyFileSync(thumb, dest);
      }
    }
    // Old selected drawing ids no longer identify a file.
    db.prepare('UPDATE todos SET selected_doc_tab = NULL WHERE id = ? AND selected_doc_tab LIKE ?').run(task.id, 'g:%');
  }
  db.exec('DROP TABLE document_versions; DROP TABLE drawings;');
}
