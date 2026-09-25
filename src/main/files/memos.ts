// MemoStore — 备忘录存储 (schema v21)。
//
// 拖入的碎片先落这里，因为拖的那一刻无法预知它是一段记录、某个任务的
// 进展、还是一个新任务。用户随后交互整理：并入任务 / 变成新任务 /
// 标记为纯记录。
//
// 两条独立的存储：
//   - DB 行（memos + memo_attachments）= 事实来源。列表、筛选、整理动作
//     全部读它。
//   - 磁盘目录 {dataDir}/memos/{id6}-{slug}/ = 用户可见的耐久投影
//     （memo.md / memo.json / attachments/）。写失败只 warn 不抛 —— 与
//     DocumentStore.writeToFile 同一取舍：DB 已经是真相，文件只是备份。
//
// 与 TaskDirectoryStore 的差异见 paths.ts 的 memoDir 注释 —— memo 没有
// 改名语义，目录名每次从 id + preview 现算。

import type Database from 'better-sqlite3';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { newId } from '../db/schema';
import { mimeExt, sanitizeName } from '../util/mime';
import { logger } from '../logger';
import type {
  Memo,
  MemoAttachment,
  MemoSource,
  ULID,
} from '../../shared/todo-types';
import {
  memoAttachmentFile,
  memoDir,
  memoFile,
  memoJsonPath,
} from './paths';

interface MemoRow {
  id: string;
  content: string;
  preview: string;
  source: MemoSource;
  todo_id: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AttachRow {
  id: string;
  memo_id: string;
  file_path: string;
  mime: string;
  created_at: number;
}

function rowToAttach(row: AttachRow): MemoAttachment {
  return {
    id: row.id,
    memoId: row.memo_id,
    filePath: row.file_path,
    mime: row.mime,
    createdAt: row.created_at,
  };
}

export interface MemoPatch {
  content?: string;
  todoId?: ULID | null;
  resolvedAt?: number | null;
}

export class MemoStore {
  constructor(
    private db: Database.Database,
    /** {dataDir}/memos —— 与 todos/ 同级，因为碎片不属于任何任务。 */
    private memosDir: string,
  ) {}

  /** 列表按创建时间倒序（新的在上）。`includeResolved` 默认 false —— 列表
   *  默认只显示待整理的条目，已整理的折叠进「已整理」小节。 */
  list(includeResolved = false): Memo[] {
    const rows = this.db
      .prepare<[], MemoRow>(
        includeResolved
          ? 'SELECT * FROM memos ORDER BY created_at DESC, id DESC'
          : 'SELECT * FROM memos WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC',
      )
      .all();
    return rows.map((r) => this.hydrate(r));
  }

  get(id: ULID): Memo | null {
    const row = this.db
      .prepare<[ULID], MemoRow>('SELECT * FROM memos WHERE id = ?')
      .get(id);
    return row ? this.hydrate(row) : null;
  }

  /** Create a memo row + mirror its file projection. `content` is the raw
   *  Markdown the user dropped; `preview` is derived from it (first
   *  non-empty line, capped) so the list row and the directory name have
   *  something readable without the renderer re-deriving it. */
  create(content: string, source: MemoSource = 'drop'): Memo {
    const id = newId();
    const now = Date.now();
    const preview = derivePreview(content);
    this.db
      .prepare(
        `INSERT INTO memos (id, content, preview, source, todo_id, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, content, preview, source, now, now);
    const memo = this.get(id)!;
    this.writeProjection(memo);
    return memo;
  }

  update(id: ULID, patch: MemoPatch): Memo | null {
    const before = this.get(id);
    if (!before) return null;
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.content !== undefined) {
      sets.push('content = ?', 'preview = ?');
      params.push(patch.content, derivePreview(patch.content));
    }
    if (patch.todoId !== undefined) {
      sets.push('todo_id = ?');
      params.push(patch.todoId);
    }
    if (patch.resolvedAt !== undefined) {
      sets.push('resolved_at = ?');
      params.push(patch.resolvedAt);
    }
    if (sets.length > 0) {
      const now = Date.now();
      sets.push('updated_at = ?');
      params.push(now);
      params.push(id);
      this.db
        .prepare(`UPDATE memos SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params);
    }
    const after = this.get(id);
    // Only re-mirror when the body changed. A todo_id / resolved_at bump
    // doesn't alter memo.md, and rewriting it on every organize action would
    // churn the file projection for nothing.
    if (after && patch.content !== undefined) this.writeProjection(after);
    return after;
  }

  /** Delete the row (+ attachment rows via FK cascade) and the whole
   *  per-memo directory. The directory removal is best-effort: if it fails
   *  (a file locked by another process), the row is still gone and the
   *  leftover directory is inert. Mirrors the "no active orphan sweep"
   *  tradeoff already taken by composer-inbox. */
  remove(id: ULID): void {
    const memo = this.get(id);
    this.db.prepare('DELETE FROM memos WHERE id = ?').run(id);
    if (memo) {
      try {
        rmSync(this.dirFor(memo), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`MemoStore.remove: failed to remove dir for ${id}: ${(err as Error).message}`);
      }
    }
  }

  // ----- attachments -----

  listAttachments(memoId: ULID): MemoAttachment[] {
    return this.db
      .prepare<[ULID], AttachRow>(
        'SELECT * FROM memo_attachments WHERE memo_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(memoId)
      .map(rowToAttach);
  }

  /** Copy an on-disk file into the memo's attachments dir + record the row.
   *  Mirrors InboxStore.attach: the DB row stores the absolute path so the
   *  renderer can be handed a data: URL without learning any path. */
  attach(memoId: ULID, filePath: string, mime: string): MemoAttachment {
    const memo = this.requireMemo(memoId);
    const id = newId();
    const fname = `${id}-${basename(filePath)}`;
    const target = memoAttachmentFile(this.dirFor(memo), fname);
    copyFileSync(filePath, target);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO memo_attachments (id, memo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, memoId, target, mime, now);
    return { id, memoId, filePath: target, mime, createdAt: now };
  }

  /** Decode a data: URL into an attachment. Used for drops whose File has
   *  no on-disk path (e.g. an image dragged straight out of a browser). */
  attachBlob(memoId: ULID, dataUrl: string, filename: string, mime: string): MemoAttachment {
    const decoded = decodeDataUrl(dataUrl);
    const ext = mimeExt(mime || decoded.mime);
    const memo = this.requireMemo(memoId);
    const id = newId();
    const fname = `${id}-${sanitizeName(filename) || 'pasted'}.${ext}`;
    const target = memoAttachmentFile(this.dirFor(memo), fname);
    writeFileSync(target, decoded.bytes);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO memo_attachments (id, memo_id, file_path, mime, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, memoId, target, mime || decoded.mime, now);
    return { id, memoId, filePath: target, mime: mime || decoded.mime, createdAt: now };
  }

  /** Read an attachment's bytes back as a data: URL for an <img src>. */
  readAttachment(id: ULID): { dataUrl: string; mime: string; filename: string } {
    const row = this.db
      .prepare<[ULID], AttachRow>('SELECT * FROM memo_attachments WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`memo_attachment_not_found: ${id}`);
    if (!existsSync(row.file_path)) throw new Error(`memo_attachment_missing: ${id}`);
    const b64 = readFileSync(row.file_path).toString('base64');
    const raw = basename(row.file_path);
    const dash = raw.indexOf('-');
    return {
      dataUrl: `data:${row.mime};base64,${b64}`,
      mime: row.mime,
      filename: dash >= 0 ? raw.slice(dash + 1) : raw,
    };
  }

  removeAttachment(id: ULID): void {
    this.db.prepare('DELETE FROM memo_attachments WHERE id = ?').run(id);
  }

  // ----- internals -----

  private requireMemo(id: ULID): Memo {
    const memo = this.get(id);
    if (!memo) throw new Error(`memo_not_found: ${id}`);
    return memo;
  }

  private hydrate(row: MemoRow): Memo {
    const attachmentIds = this.db
      .prepare<[ULID], { id: string }>(
        'SELECT id FROM memo_attachments WHERE memo_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(row.id)
      .map((r) => r.id);
    return {
      id: row.id,
      content: row.content,
      preview: row.preview,
      source: row.source,
      todoId: row.todo_id,
      resolvedAt: row.resolved_at,
      attachmentIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private dirFor(memo: Memo): string {
    return memoDir(this.memosDir, memo.id, memo.preview);
  }

  /** Mirror the memo to disk: memo.md (content) + memo.json (metadata
   *  snapshot). Best-effort — a failure logs and continues, because the DB
   *  row is the authority and the file is a projection. */
  writeProjection(memo: Memo): void {
    try {
      const dir = this.dirFor(memo);
      writeFileSync(memoFile(dir), memo.content, 'utf8');
      writeFileSync(
        memoJsonPath(dir),
        JSON.stringify(
          {
            id: memo.id,
            preview: memo.preview,
            source: memo.source,
            todoId: memo.todoId,
            resolvedAt: memo.resolvedAt,
            createdAt: memo.createdAt,
            updatedAt: memo.updatedAt,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (err) {
      logger.warn(`MemoStore.writeProjection failed for ${memo.id}: ${(err as Error).message}`);
    }
  }
}

/** Display summary for the list row + directory slug: the first non-empty
 *  line, whitespace-collapsed, capped at 60 chars. Keeps a multi-line drop
 *  from blowing out the row height while still showing enough to recognize
 *  the fragment. */
export function derivePreview(content: string): string {
  const firstLine =
    content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('dataUrl 格式不正确');
  const mime = m[1] || 'application/octet-stream';
  const payload = m[2] ?? '';
  const isBase64 = /;base64/i.test(dataUrl.slice(0, dataUrl.indexOf(',')));
  return {
    mime,
    bytes: isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8'),
  };
}
