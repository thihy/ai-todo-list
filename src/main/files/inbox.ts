// Inbox attachment storage. Each attachment is a file on disk under
// <dataDir>/inbox-attachments/ referenced by an `inbox_attachments` DB row.
//
// This store owns the full lifecycle: attach (copy a file path), attachBlob
// (decode a data: URL), list, read (→ data: URL for the renderer, so the
// renderer never learns the main-process absolute path), remove (file + row).
//
// `task_documents` rows of kind 'attachment' carry a refId pointing at an
// inbox_attachments.id — this store is the content-of-truth; DocumentStore
// only owns the list metadata for that kind.

import type Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { newId } from '../db/schema';
import { mimeExt, sanitizeName } from '../util/mime';
import type { InboxAttachment, ULID } from '../../shared/todo-types';

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
    private attachmentsDir: string,
  ) {
    mkdirSync(attachmentsDir, { recursive: true });
  }

  /** List a task's attachments, newest first. */
  list(todoId: ULID): InboxAttachment[] {
    return this.db
      .prepare<[ULID], AttachRow>(
        'SELECT id, todo_id, file_path, mime, created_at FROM inbox_attachments WHERE todo_id = ? ORDER BY created_at DESC',
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

  /** Copy a file from `filePath` into the attachments dir + record the row.
   *  `id` param is the todoId (matches the legacy `inbox.attach` arg shape). */
  attach(todoId: ULID, filePath: string, mime: string): InboxAttachment {
    const id = newId();
    const filename = `${id}-${basename(filePath)}`;
    const target = join(this.attachmentsDir, filename);
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
    const target = join(this.attachmentsDir, fname);
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
}
