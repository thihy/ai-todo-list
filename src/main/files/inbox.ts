// Inbox attachment storage. Each attachment is a file on disk referenced by
// an `inbox_attachments` DB row.
//
// Per-task layout (post-refactor):
//
//   {dataDir}/todos/{slug}/attachments/{id}-{name}
//
// The DB row's `file_path` column stores the absolute on-disk path (so the
// `attachment://` protocol handler can stream bytes without re-resolving
// anything). `task_documents` rows of kind 'attachment' carry a refId
// pointing at inbox_attachments.id — this store is the content-of-truth;
// DocumentStore only owns the list metadata for that kind.

import type Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ULID } from '../../shared/todo-types';
import { newId } from '../db/schema';
import { logger } from '../logger';
import { mimeExt, sanitizeName } from '../util/mime';
import type { InboxAttachment } from '../../shared/todo-types';
import { attachmentFile } from './paths';

interface AttachRow {
  id: string;
  todo_id: string;
  file_path: string;
  mime: string;
  created_at: number;
}

function rowToAttach(row: AttachRow): InboxAttachment {
  return {
    id: row.id,
    todoId: row.todo_id,
    filePath: row.file_path,
    mime: row.mime,
    createdAt: row.created_at,
  };
}

export class InboxStore {
  constructor(
    private db: Database.Database,
    /** Legacy root used to keep any pre-refactor flat files findable for
     *  the migration sweep (Commit 8). New writes go under per-task
     *  {todosDir}/{slug}/attachments/. */
    private attachmentsDir: string,
    private todosDir: string,
    private resolveTaskDir: (todoId: ULID) => string,
  ) {
    mkdirSync(attachmentsDir, { recursive: true });
    mkdirSync(todosDir, { recursive: true });
  }

  private taskDirFor(todoId: ULID): string {
    return this.resolveTaskDir(todoId);
  }

  /** Legacy flat attachments root. New writes go under per-task
   *  {todosDir}/{slug}/attachments/; the migration sweep (Commit 8) reads
   *  this directory to relocate pre-refactor attachments. */
  get legacyAttachmentsDir(): string {
    return this.attachmentsDir;
  }

  /** Per-task attachments root (shared parent of all {slug}/attachments/
   *  subdirs). Kept on the store so the migration sweep can relocate the
   *  old flat files without re-importing the todosDir constant. */
  get todosRoot(): string {
    return this.todosDir;
  }

  /** List a task's attachments in upload order (oldest first). */
  list(todoId: ULID): InboxAttachment[] {
    return this.db
      .prepare<[ULID], AttachRow>(
        'SELECT id, todo_id, file_path, mime, created_at FROM inbox_attachments WHERE todo_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(todoId)
      .map(rowToAttach);
  }

  /** Look up a single attachment row (no file read). */
  get(id: ULID): InboxAttachment | null {
    const row = this.db
      .prepare<[ULID], AttachRow>(
        'SELECT id, todo_id, file_path, mime, created_at FROM inbox_attachments WHERE id = ?',
      )
      .get(id);
    return row ? rowToAttach(row) : null;
  }

  /** Copy a file from `filePath` into the per-task attachments dir + record
   *  the row. `id` param is the todoId (matches the legacy `inbox.attach`
   *  arg shape). */
  attach(todoId: ULID, filePath: string, mime: string): InboxAttachment {
    const id = newId();
    const taskDir = this.taskDirFor(todoId);
    const filename = `${id}-${basename(filePath)}`;
    const target = attachmentFile(taskDir, filename);
    copyFileSync(filePath, target);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, todoId, target, mime, now);
    return { id, todoId, filePath: target, mime, createdAt: now };
  }

  /** Decode a data: URL (base64 or percent-encoded) into a file + record row.
   *  Used for pasted/dropped images from the renderer. */
  attachBlob(todoId: ULID, dataUrl: string, filename: string, mime: string): InboxAttachment {
    const id = newId();
    const comma = dataUrl.indexOf(',');
    const header = dataUrl.slice(0, comma);
    const isBase64 = /;base64/i.test(header);
    const payload = dataUrl.slice(comma + 1);
    const buf = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    const ext = mimeExt(mime);
    const fname = `${id}-${sanitizeName(filename) || 'pasted'}.${ext}`;
    const taskDir = this.taskDirFor(todoId);
    const target = attachmentFile(taskDir, fname);
    writeFileSync(target, buf);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO inbox_attachments (id, todo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, todoId, target, mime, now);
    return { id, todoId, filePath: target, mime, createdAt: now };
  }

  /** Read an attachment's bytes back as a data: URL so the renderer can embed
   *  it (e.g. an <img src>) without learning the absolute path. The display
   *  name is derived from the file path (the `${id}-` prefix stripped). */
  read(id: ULID): { dataUrl: string; mime: string; filename: string } {
    const row = this.get(id);
    if (!row) throw new Error(`attachment_not_found: ${id}`);
    if (!existsSync(row.filePath)) throw new Error(`attachment_file_missing: ${row.id}`);
    const buf = readFileSync(row.filePath);
    const b64 = buf.toString('base64');
    // Strip the `${id}-` prefix to recover a human-facing filename.
    const raw = basename(row.filePath);
    const dash = raw.indexOf('-');
    const filename = dash >= 0 ? raw.slice(dash + 1) : raw;
    return { dataUrl: `data:${row.mime};base64,${b64}`, mime: row.mime, filename };
  }

  /** Delete the file + the DB row. Idempotent — a missing file is not an
   *  error (the row is still removed). */
  remove(id: ULID): void {
    const row = this.get(id);
    if (row && existsSync(row.filePath)) {
      try {
        unlinkSync(row.filePath);
      } catch {
        // best-effort; the row is the source of truth and will be removed.
      }
    }
    this.db.prepare('DELETE FROM inbox_attachments WHERE id = ?').run(id);
  }

  /**
   * Rename an attachment. Five things happen in order:
   *
   *   1. Locate the inbox_attachments row (throws if missing).
   *   2. Rename the on-disk file from `{ulid}-{oldName}.{ext}` to
   *      `{ulid}-{newName}.{ext}`. The ulid stays at the front so the file
   *      is still findable by id (InboxStore.read strips it on read-back);
   *      only the human-facing portion of the filename changes.
   *   3. Update `inbox_attachments.file_path` to the new absolute path so the
   *      `attachment://<id>` protocol handler keeps serving bytes from the
   *      same id.
   *   4. Update the companion `task_documents.title` row (kind='attachment',
   *      ref_id=this id). This is the canonical display name shown in the
   *      附件 section.
   *   5. Sweep every progress / note_md document belonging to this task and
   *      replace `![oldAlt](attachment://<id>)` with
   *      `![newTitle](attachment://<id>)` so inline images stay in sync. The
   *      sweep writes each affected doc via the injected callback so the
   *      caller (DocumentStore) owns the document.write + content broadcast.
   *
   * The disk rename is best-effort: if it fails (e.g. cross-platform path
   * collision, read-only FS) the DB and task_documents still update — the
   * user-visible name change survives even when the file basename can't be
   * touched, and the protocol handler still streams from the new path on the
   * next read-back attempt.
   */
  rename(
    id: ULID,
    newName: string,
    /** Called once per progress / note_md doc whose content was rewritten.
     *  Receives the doc id + the new full content; throws to abort the
     *  rename if a write fails. */
    onRewriteDoc: (docId: ULID, content: string) => void,
  ): InboxAttachment {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('attachment_name_empty');
    const row = this.get(id);
    if (!row) throw new Error(`attachment_not_found: ${id}`);

    // --- (2) rename the on-disk file, preserving the ulid prefix ---
    const oldBase = basename(row.filePath);
    const ext = oldBase.includes('.') ? oldBase.slice(oldBase.lastIndexOf('.')) : '';
    const sanitized = sanitizeName(trimmed) || 'attachment';
    const newBase = `${id}-${sanitized}${ext}`;
    const newPath = attachmentFile(dirname(row.filePath), newBase);
    if (newPath !== row.filePath) {
      try {
        if (existsSync(row.filePath)) renameSync(row.filePath, newPath);
        else logger.warn(`inbox.rename: source missing on disk, skip fs rename: ${row.filePath}`);
      } catch (err) {
        logger.warn(`inbox.rename: filesystem rename failed, keeping DB update: ${(err as Error).message}`);
      }
    }
    const now = Date.now();

    // --- (3) update inbox_attachments.file_path in a single SQL ---
    this.db
      .prepare('UPDATE inbox_attachments SET file_path = ? WHERE id = ?')
      .run(newPath, id);

    // --- (4) update companion task_documents.title (if any) ---
    this.db
      .prepare(
        `UPDATE task_documents SET title = ?, updated_at = ?
         WHERE kind = 'attachment' AND ref_id = ?`,
      )
      .run(trimmed, now, id);

    // --- (5) sweep progress / note_md docs, rewrite inline image alts ---
    const docs = this.db
      .prepare<[ULID], { id: string; content: string | null }>(
        `SELECT d.id AS id, v.content AS content
         FROM task_documents d
         LEFT JOIN document_versions v ON v.id = (
           SELECT MAX(id) FROM document_versions WHERE document_id = d.id
         )
         WHERE d.todo_id = ? AND d.kind IN ('progress', 'note_md')`,
      )
      .all(row.todoId);
    // 用一个保守的占位替代原 alt：先把命中区间整体替换成 `\0ULID<i>...<br>`，
    // 全部替换完成后再把占位换回新 title —— 这样新 title 里出现 `[` `]` `(` `)`
    // 等 markdown 元字符时不会二次破坏语法。
    const placeholder = `\x00ATT${id}\x00`;
    const re = new RegExp(`!\\[([^\\]]*)\\]\\(attachment://${id}\\)`, 'g');
    let touched = 0;
    for (const doc of docs) {
      const original = doc.content ?? '';
      if (!re.test(original)) {
        re.lastIndex = 0;
        continue;
      }
      re.lastIndex = 0;
      const replaced = original.replace(re, `![${placeholder}](attachment://${id})`);
      const finalContent = replaced.replaceAll(placeholder, trimmed);
      if (finalContent === original) continue;
      onRewriteDoc(doc.id, finalContent);
      touched++;
    }
    if (touched > 0) {
      logger.info(`inbox.rename: rewrote ${touched} doc(s) for attachment ${id}`);
    }
    return { ...row, filePath: newPath };
  }
}
