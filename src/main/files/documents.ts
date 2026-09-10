// DocumentStore — multi-document storage for a task's workspace (schema v11).
//
// A task owns `task_documents` rows (kind ∈ progress | note_md | drawing |
// attachment | link). This store manages those rows + the versioned text
// content of the progress / note_md docs (stored in `document_versions`,
// same pattern as the legacy content_versions table — DB text, no file paths,
// so migrations are pure SQL and there's no file-path churn).
//
// Drawings / attachments / links carry no versioned content here: their
// content is referenced via refId / url and managed by their own stores
// (DrawingStore / inbox IPC). This store just owns the list metadata for
// those kinds (create / remove / rename / list).

import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../db/schema';
import type {
  DocumentKind,
  DocumentVersionEntry,
  TaskDocument,
  ULID,
} from '../../shared/todo-types';
import { MAX_BODY_VERSIONS } from '../../shared/constants';
import { noteFile, progressFile } from './paths';
import { logger } from '../logger';

interface DocRow {
  id: string;
  todo_id: string;
  kind: DocumentKind;
  title: string | null;
  ref_id: string | null;
  url: string | null;
  description: string | null;
  ord: number;
  created_at: number;
  updated_at: number;
}

function rowToDoc(row: DocRow): TaskDocument {
  return {
    id: row.id,
    todoId: row.todo_id,
    kind: row.kind,
    title: row.title,
    refId: row.ref_id,
    url: row.url,
    description: row.description,
    ord: row.ord,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_TITLE: Record<DocumentKind, string> = {
  progress: '进展',
  note_md: '笔记',
  drawing: '绘图',
  attachment: '附件',
  link: '链接',
};

export class DocumentStore {
  constructor(private db: Database.Database) {}

  /** List a task's documents, ordered by ord then creation. The progress
   *  doc is always ord 0 so it sits at the top of the workspace list. */
  list(todoId: ULID): TaskDocument[] {
    const rows = this.db
      .prepare<[ULID], DocRow>(
        'SELECT * FROM task_documents WHERE todo_id = ? ORDER BY ord ASC, created_at ASC',
      )
      .all(todoId);
    return rows.map(rowToDoc);
  }

  /** Ensure the task has at least its default progress doc, and surface any
   *  legacy .md body (content_versions) as a note_md doc. Idempotent — the
   *  v11 migration does this for pre-existing todos; this covers todos created
   *  AFTER the migration (new tasks that still wrote via MarkdownStore) on
   *  first open of the workspace. Safe to call on every list. */
  ensureDefaultDocs(todoId: ULID): void {
    const hasProgress = this.db
      .prepare('SELECT 1 FROM task_documents WHERE todo_id = ? AND kind = ?')
      .get(todoId, 'progress');
    if (!hasProgress) {
      this.create(todoId, 'progress', '进展');
    }
    // Bridge the legacy .md body into a note_md doc so existing notes are
    // visible in the new workspace. Copies the full content_versions history
    // into document_versions (same pattern as the v11 migration).
    const hasNote = this.db
      .prepare('SELECT 1 FROM task_documents WHERE todo_id = ? AND kind = ?')
      .get(todoId, 'note_md');
    if (!hasNote) {
      const legacy = this.db
        .prepare<[ULID], { c: number }>(
          'SELECT COUNT(*) as c FROM content_versions WHERE todo_id = ?',
        )
        .get(todoId);
      if (legacy && legacy.c > 0) {
        this.createNoteMdFromLegacy(todoId);
      }
    }
  }

  /** Create a note_md doc for a todo and copy its legacy content_versions
   *  history into document_versions (oldest→newest insertion order so the
   *  latest content_versions row lands as the newest document_version). */
  private createNoteMdFromLegacy(todoId: ULID): void {
    const doc = this.create(todoId, 'note_md', '笔记');
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO document_versions (document_id, content, saved_at)
           SELECT ?, body, saved_at FROM content_versions WHERE todo_id = ? ORDER BY id ASC`,
        )
        .run(doc.id, todoId);
      const latest = this.db
        .prepare<[string], { saved_at: number | null }>(
          'SELECT MAX(saved_at) as saved_at FROM document_versions WHERE document_id = ?',
        )
        .get(doc.id);
      if (latest?.saved_at) {
        this.db
          .prepare('UPDATE task_documents SET updated_at = ? WHERE id = ?')
          .run(latest.saved_at, doc.id);
      }
    });
    tx();
  }

  /** Create a document row. For progress / note_md, content starts empty
   *  (no document_versions row; read() returns '' until the first write).
   *  For drawing / attachment, pass refId; for link, pass url. `ord`
   *  defaults to "after the last doc" so new docs append to the list. */
  create(
    todoId: ULID,
    kind: DocumentKind,
    title?: string | null,
    opts?: { refId?: string | null; url?: string | null; description?: string | null; ord?: number },
  ): TaskDocument {
    const id = newId();
    const now = Date.now();
    const ord =
      opts?.ord ??
      (this.db
        .prepare<[ULID], { m: number | null }>(
          'SELECT MAX(ord) as m FROM task_documents WHERE todo_id = ?',
        )
        .get(todoId)?.m ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO task_documents (id, todo_id, kind, title, ref_id, url, description, ord, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        todoId,
        kind,
        title ?? DEFAULT_TITLE[kind] ?? null,
        opts?.refId ?? null,
        opts?.url ?? null,
        opts?.description ?? null,
        ord,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: ULID): TaskDocument | null {
    const row = this.db
      .prepare<[ULID], DocRow>('SELECT * FROM task_documents WHERE id = ?')
      .get(id);
    return row ? rowToDoc(row) : null;
  }

  /** Read the latest versioned content of a progress / note_md doc.
   *  Returns { content: '', version: 0 } for an empty / never-written doc. */
  read(id: ULID): { content: string; version: number } {
    const row = this.db
      .prepare<[ULID], { id: number; content: string }>(
        'SELECT id, content FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(id);
    return row ? { content: row.content, version: row.id } : { content: '', version: 0 };
  }

  /** Append a new version of a progress / note_md doc. expectVersion enables
   *  optimistic concurrency (same scheme as MarkdownStore.writeBody). Trims
   *  to MAX_BODY_VERSIONS, newest kept. */
  write(id: ULID, content: string, expectVersion?: number): { version: number; updatedAt: number } {
    if (expectVersion != null) {
      const current = this.db
        .prepare<[ULID], { v: number | null }>(
          'SELECT MAX(id) as v FROM document_versions WHERE document_id = ?',
        )
        .get(id)?.v ?? 0;
      if (current !== expectVersion) {
        throw new Error(`version_conflict: expected ${expectVersion}, current ${current}`);
      }
    }
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO document_versions (document_id, content, saved_at) VALUES (?, ?, ?)',
        )
        .run(id, content, now);
      // Trim to MAX_BODY_VERSIONS, keeping newest (highest id).
      this.db
        .prepare(
          `DELETE FROM document_versions
           WHERE document_id = ? AND id NOT IN (
             SELECT id FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(id, id, MAX_BODY_VERSIONS);
      this.db
        .prepare('UPDATE task_documents SET updated_at = ? WHERE id = ?')
        .run(now, id);
      // For note_md docs, mirror the content onto todos.body so the FTS5
      // external-content table stays in sync (search snippets read todos.body).
      // The progress doc is HTML and intentionally not FTS-indexed. We look up
      // the doc's todoId + kind in one statement to avoid an extra round-trip.
      this.db
        .prepare(
          `UPDATE todos SET body = ?, updated_at = ?
           WHERE id = (SELECT todo_id FROM task_documents WHERE id = ?)
             AND EXISTS (SELECT 1 FROM task_documents WHERE id = ? AND kind = 'note_md')`,
        )
        .run(content, now, id, id);
    });
    tx();
    const version = this.db
      .prepare<[ULID], { v: number | null }>(
        'SELECT MAX(id) as v FROM document_versions WHERE document_id = ?',
      )
      .get(id)?.v ?? 0;
    return { version, updatedAt: now };
  }

  history(id: ULID): DocumentVersionEntry[] {
    return this.db
      .prepare<[ULID], { id: number; document_id: string; content: string; saved_at: number }>(
        'SELECT id, document_id, content, saved_at FROM document_versions WHERE document_id = ? ORDER BY saved_at DESC',
      )
      .all(id)
      .map((r) => ({ id: r.id, documentId: r.document_id, content: r.content, savedAt: r.saved_at }));
  }

  restoreVersion(id: ULID, versionId: number): void {
    const v = this.db
      .prepare<[ULID, number], { content: string }>(
        'SELECT content FROM document_versions WHERE document_id = ? AND id = ?',
      )
      .get(id, versionId);
    if (!v) throw new Error(`version_not_found: ${versionId}`);
    this.write(id, v.content);
  }

  rename(id: ULID, title: string): void {
    this.db
      .prepare('UPDATE task_documents SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  /** Mirror the latest content of a progress / note_md doc to its on-disk file.
   *  Best-effort: try/catch + logger.warn + swallow. The DB is the authority;
   *  the file is a write-through projection for git history + file explorer.
   *  Drawing / attachment / link docs are NOT mirrored here — DrawingStore and
   *  InboxStore own their own file paths. */
  writeToFile(taskDir: string, kind: 'progress' | 'note_md', title: string, content: string): void {
    try {
      const path = kind === 'progress' ? progressFile(taskDir) : noteFile(taskDir, title);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    } catch (err) {
      logger.warn(`DocumentStore.writeToFile(${kind}) failed: ${(err as Error).message}`);
    }
  }

  /** Remove the on-disk file backing a progress / note_md doc. Best-effort. */
  removeFile(taskDir: string, kind: 'progress' | 'note_md', title: string): void {
    try {
      const path = kind === 'progress' ? progressFile(taskDir) : noteFile(taskDir, title);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      logger.warn(`DocumentStore.removeFile(${kind}) failed: ${(err as Error).message}`);
    }
  }

  /** Rename the on-disk file for a note_md doc when its title changes.
   *  Progress docs are at a fixed path (progress.html) so this is a no-op for
   *  kind === 'progress'. Best-effort. */
  renameFile(
    taskDir: string,
    kind: 'progress' | 'note_md',
    oldTitle: string,
    newTitle: string,
  ): void {
    if (kind === 'progress') return;
    try {
      const oldPath = noteFile(taskDir, oldTitle);
      const newPath = noteFile(taskDir, newTitle);
      if (existsSync(oldPath) && oldPath !== newPath) renameSync(oldPath, newPath);
    } catch (err) {
      logger.warn(`DocumentStore.renameFile(${kind}) failed: ${(err as Error).message}`);
    }
  }

  /** Remove a document row. document_versions cascade via FK. For drawing /
   *  attachment docs this only removes the list entry — the referenced
   *  drawings / inbox rows survive (managed by their own stores). */
  remove(id: ULID): void {
    this.db.prepare('DELETE FROM task_documents WHERE id = ?').run(id);
  }
}
