// Excalidraw drawing file storage. JSON scene + optional PNG thumb.
//
// Per-task layout:
//
//   {dataDir}/todos/{storage_dir}/
//     {drawingSlug}.excalidraw   ← JSON scene（文件名跟随标签）
//     thumbs/{drawingId}.thumb.png
//
// 映射关系的唯一真相是 DB 的 `drawings.path`（任务目录相对的文件名）。
// 标签只是「想要什么名字」：
//   - 改名 = 先改磁盘、再把成功后的文件名写回 path；
//   - 磁盘改名失败则沿用旧文件名、path 不动（标签与文件名短暂不一致，
//     但数据永远读得到，也不会凭空多出一个新文件）；
//   - 读路径永远用 path，绝不用「当前标题」反推文件名。
//
// 新建绘图的默认标签是 DEFAULT_DRAWING_TITLE（绘图），所以磁盘上应该是
// 绘图.excalidraw，而不是旧版自动保存退化出来的 untitled.excalidraw。

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
import { basename, dirname, join } from 'node:path';
import { newId } from '../db/schema';
import type { DrawingMeta, ULID } from '../../shared/todo-types';
import {
  allocateFileName,
  DEFAULT_DRAWING_TITLE,
  drawingFile,
  drawingFileName,
  thumbFile,
} from './paths';
import { logger } from '../logger';
import type { TaskFileIndex } from './task-files';

interface DrawingRow {
  id: string;
  todo_id: string;
  title: string | null;
  path: string;
  thumb_path: string | null;
  created_at: number;
  updated_at: number;
}

export class DrawingStore {
  constructor(
    private db: Database.Database,
    /**
     * Used solely for the legacy `drawingsDir` accessor below (kept for
     * backwards compat with tests that just want a base directory). The new
     * file path lives inside each task dir.
     */
    private drawingsDir: string,
    private resolveTaskDir: (todoId: ULID) => string,
    /** 任务目录的文件扫描索引 —— 与 DocumentStore 共用同一个实例。绘图
     *  写完 / 搬完文件后必须让它忘掉旧缓存，否则 tab 列表还会显示已经不在
     *  磁盘上的绘图。没传就退化成「不参与缓存」（只在测试里出现）。 */
    private files?: TaskFileIndex,
  ) {
    mkdirSync(drawingsDir, { recursive: true });
  }

  /** 绘图文件动了(新建 / 改名 / 删除)之后让扫描缓存失效。 */
  private invalidate(taskDir: string): void {
    this.files?.invalidate(taskDir);
  }

  /** Resolve on each operation so a successful task-directory rename is
   *  observed immediately. The injected resolver is stable via SQLite. */
  private taskDirFor(todoId: ULID): string {
    return this.resolveTaskDir(todoId);
  }

  /** Legacy accessor — kept so external callers (git-history, tests) can
   *  still find the parent directory of all drawing files. After Commit 9,
   *  git-history will switch to per-task dirs and this accessor goes away. */
  get baseDir(): string {
    return this.drawingsDir;
  }

  list(todoId: ULID): DrawingMeta[] {
    return this.db
      .prepare<[ULID], {
        id: string;
        todo_id: string;
        title: string | null;
        thumb_path: string | null;
        created_at: number;
        updated_at: number;
      }>(
        'SELECT id, todo_id, title, thumb_path, created_at, updated_at FROM drawings WHERE todo_id = ? ORDER BY updated_at DESC',
      )
      .all(todoId)
      .map((r) => ({
        id: r.id,
        todoId: r.todo_id,
        title: r.title,
        thumbPath: r.thumb_path,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Single drawing meta by id (for rename return value). Null if missing. */
  get(id: ULID): DrawingMeta | null {
    const r = this.db
      .prepare<[ULID], {
        id: string;
        todo_id: string;
        title: string | null;
        thumb_path: string | null;
        created_at: number;
        updated_at: number;
      }>(
        'SELECT id, todo_id, title, thumb_path, created_at, updated_at FROM drawings WHERE id = ?',
      )
      .get(id);
    if (!r) return null;
    return {
      id: r.id,
      todoId: r.todo_id,
      title: r.title,
      thumbPath: r.thumb_path,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  read(id: ULID): unknown {
    const row = this.row(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const located = this.locateScene(row);
    if (!existsSync(located.absolute)) throw new Error(`drawing_file_missing: ${located.absolute}`);
    return JSON.parse(readFileSync(located.absolute, 'utf8'));
  }

  /** Create or update a drawing.
   *
   *  `title` 语义（这是修复 untitled.excalidraw 的关键）：
   *   - `undefined` —— 调用方只想回写场景（画布自动保存）。已有行**保持原
   *     标签和原文件名**；新建行用默认标签（绘图 / 绘图 2 …）。
   *   - 字符串 —— 目标标签，空串表示清空（文件名回退到「绘图」）。
   */
  save(todoId: ULID, scene: unknown, id?: ULID, title?: string): DrawingMeta {
    const drawingId = id ?? newId();
    const now = Date.now();
    const taskDir = this.taskDirFor(todoId);
    const existing = this.row(drawingId);

    let newTitle: string;
    if (existing) {
      newTitle = title === undefined ? (existing.title ?? '') : title.trim();
    } else {
      newTitle = title === undefined ? DEFAULT_DRAWING_TITLE : title.trim();
      if (!newTitle) newTitle = DEFAULT_DRAWING_TITLE;
    }

    // 文件名：已有行走「改名 → 成功才更新 path」，新行走一次唯一名分配。
    const relPath = existing
      ? this.moveScene(taskDir, existing, newTitle, drawingId)
      : allocateFileName(taskDir, drawingFileName(newTitle), this.claimedPaths(todoId));

    // 调用方没给标签时（新建 / 自动保存），标签直接取自分配到的文件名：
    // 「文件名 = 标签名」必须严格成立，撞名时标签跟着变成 绘图_1 / 文档_1。
    // 先算出标签再算文件名会绕一圈产生「绘图 2 → 绘图_2.md」这种标签与
    // 文件名对不上的中间态。
    if (!existing && (title === undefined || !title.trim())) {
      newTitle = relPath.slice(0, -'.excalidraw'.length);
    }

    this.writeScene(taskDir, relPath, scene);
    this.invalidate(taskDir);

    if (existing) {
      this.db
        .prepare('UPDATE drawings SET title = ?, path = ?, updated_at = ? WHERE id = ?')
        .run(newTitle || null, relPath, now, drawingId);
    } else {
      this.db
        .prepare(
          'INSERT INTO drawings (id, todo_id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(drawingId, todoId, newTitle || null, relPath, now, now);
    }

    return this.get(drawingId)!;
  }

  delete(id: ULID): void {
    // Capture file paths BEFORE the row goes away so we can still clean them
    // up if the unlink fails.
    const row = this.row(id);
    this.db.prepare('DELETE FROM drawings WHERE id = ?').run(id);
    if (!row) return;
    const taskDir = this.taskDirFor(row.todo_id);
    const located = this.locateScene(row);
    this.bestEffortUnlink(located.absolute);
    // 磁盘改名失败过的老数据：映射还指在旧文件名上，顺手把它也清掉。
    this.bestEffortUnlink(join(taskDir, this.legacyFileName(row)));
    this.bestEffortUnlink(thumbFile(taskDir, id));
    this.invalidate(taskDir);
  }

  /** Rename a drawing's title — the label and the file name move together.
   *  The DB mapping (`path`) is only updated once the filesystem rename
   *  succeeds; on failure the drawing keeps its old file name and stays
   *  readable. */
  rename(id: ULID, title: string): void {
    const before = this.row(id);
    if (!before) return;
    const newTitle = (title ?? '').trim();
    const taskDir = this.taskDirFor(before.todo_id);
    const relPath = this.moveScene(taskDir, before, newTitle, id);
    this.invalidate(taskDir);
    this.db
      .prepare('UPDATE drawings SET title = ?, path = ?, updated_at = ? WHERE id = ?')
      .run(newTitle || null, relPath, Date.now(), id);
  }

  setThumb(id: ULID, dataUrl: string): void {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const row = this.db
      .prepare<[ULID], { todo_id: string }>('SELECT todo_id FROM drawings WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`drawing_not_found: ${id}`);
    const taskDir = this.taskDirFor(row.todo_id);
    const fullPath = thumbFile(taskDir, id);
    const thumbRelPath = `thumbs/${id}.thumb.png`;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    this.db
      .prepare('UPDATE drawings SET thumb_path = ? WHERE id = ?')
      .run(thumbRelPath, id);
  }

  /** Reconcile historical file names with the current rule and write the
   *  resulting mapping back into `drawings.path`. Call once at startup.
   *
   *  Four kinds of legacy state are handled:
   *   1. `path` points at a file that no longer exists but the title-derived
   *      name does — older releases stored one name and moved the file to
   *      another. Adopt the file that is really there.
   *   2. Empty title — label and file name both fall back to 「绘图」.
   *   3. File name disagrees with the label — rename the file, update path.
   *   4. Several drawings in one task share a single file (old releases wrote
   *      every autosave into `untitled.excalidraw`) — copy the shared file
   *      for the later rows *before* the first one renames it away, so nobody
   *      loses their mapping.
   *
   *  Idempotent: once everything lines up this writes nothing. A failure on
   *  one task is logged and never blocks boot. */
  repairFilePaths(): void {
    const rows = this.db
      .prepare<[], DrawingRow>(
        'SELECT id, todo_id, title, path, thumb_path, created_at, updated_at FROM drawings ORDER BY todo_id, created_at, id',
      )
      .all();

    const byTodo = new Map<string, DrawingRow[]>();
    for (const row of rows) {
      const group = byTodo.get(row.todo_id);
      if (group) group.push(row);
      else byTodo.set(row.todo_id, [row]);
    }

    for (const [todoId, group] of byTodo) {
      try {
        this.repairTaskDrawings(todoId as ULID, group);
      } catch (err) {
        logger.warn(`DrawingStore.repairFilePaths(${todoId}) 失败: ${(err as Error).message}`);
      }
    }
  }

  // --- internals ---------------------------------------------------------

  private row(id: ULID): DrawingRow | undefined {
    return this.db
      .prepare<[ULID], DrawingRow>(
        'SELECT id, todo_id, title, path, thumb_path, created_at, updated_at FROM drawings WHERE id = ?',
      )
      .get(id);
  }

  /** File names registered by the OTHER drawings of one task. */
  private claimedPaths(todoId: ULID, exceptId?: ULID): Set<string> {
    const rows = this.db
      .prepare<[ULID], { id: string; path: string | null }>(
        'SELECT id, path FROM drawings WHERE todo_id = ?',
      )
      .all(todoId);
    const out = new Set<string>();
    for (const r of rows) {
      if (r.id === exceptId || !r.path) continue;
      out.add(basename(r.path));
    }
    return out;
  }

  /** Locate this drawing's scene file. */
  private locateScene(row: DrawingRow): { absolute: string; relPath: string } {
    const taskDir = this.taskDirFor(row.todo_id);
    const relPath = row.path ? basename(row.path) : drawingFileName(row.title);
    const absolute = join(taskDir, relPath);
    if (existsSync(absolute)) return { absolute, relPath };
    const legacy = this.legacyFileName(row);
    const legacyAbs = join(taskDir, legacy);
    if (legacy !== relPath && existsSync(legacyAbs)) {
      this.db.prepare('UPDATE drawings SET path = ? WHERE id = ?').run(legacy, row.id);
      return { absolute: legacyAbs, relPath: legacy };
    }
    return { absolute, relPath };
  }

  /** 旧版本 slugify('') 产生的文件名，只用于「按旧规则找到真实文件」。 */
  private legacyFileName(row: DrawingRow): string {
    return basename(drawingFile('', row.title ?? ''));
  }

  /** Move the scene file to the name the (new) label asks for and return the
   *  relative path to use from now on.
   *
   *  Success → the caller records the new path. Failure → the old path is
   *  returned unchanged, so the DB mapping keeps pointing at a file that is
   *  still there. Never returns a path that doesn't exist on disk unless the
   *  scene file was missing to begin with (then the next write recreates it). */
  private moveScene(taskDir: string, row: DrawingRow, title: string, drawingId: string): string {
    const stored = row.path ? basename(row.path) : drawingFileName(row.title);
    const desired = allocateFileName(
      taskDir,
      drawingFileName(title),
      this.claimedPaths(row.todo_id, drawingId),
      stored,
    );
    if (desired === stored) return stored;

    const from = join(taskDir, stored);
    if (!existsSync(from)) return desired; // 文件早就不在了 → 直接写新位置
    try {
      if (existsSync(join(taskDir, desired))) throw new Error(`destination_exists: ${desired}`);
      renameSync(from, join(taskDir, desired));
      return desired;
    } catch (err) {
      logger.warn(
        `DrawingStore: 文件改名失败 ${from} → ${desired}，继续沿用旧文件名（标签已更新）: ${(err as Error).message}`,
      );
      return stored;
    }
  }

  private writeScene(taskDir: string, relPath: string, scene: unknown): void {
    const full = join(taskDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(scene), 'utf8');
  }

  private repairTaskDrawings(todoId: ULID, group: DrawingRow[]): void {
    const taskDir = this.taskDirFor(todoId);

    // 1. 认领真实存在的文件（DB path 与磁盘错位时）。
    const current = new Map<string, string | null>();
    for (const row of group) {
      const located = this.locateScene(row);
      current.set(row.id, existsSync(located.absolute) ? located.relPath : null);
    }

    // 2. 共享文件拆份：多人指向同一个文件时，先给后来者复制一份，
    //    再让各自去改成自己的名字——否则第一个改名就把别人的内容搬走了。
    const byFile = new Map<string, string[]>();
    for (const row of group) {
      const file = current.get(row.id);
      if (!file) continue;
      const ids = byFile.get(file);
      if (ids) ids.push(row.id);
      else byFile.set(file, [row.id]);
    }
    for (const [file, ids] of byFile) {
      if (ids.length < 2) continue;
      const src = join(taskDir, file);
      const stem = file.endsWith('.excalidraw') ? file.slice(0, -'.excalidraw'.length) : file;
      for (let i = 1; i < ids.length; i++) {
        const id = ids[i]!;
        try {
          const copy = allocateFileName(
            taskDir,
            `${stem}.excalidraw`,
            this.claimedPaths(todoId, id),
          );
          copyFileSync(src, join(taskDir, copy));
          current.set(id, copy);
        } catch (err) {
          // 复制不了就别乱动这一行：它和第一行共享同一个文件，
          // 保持原样至少还能读到内容。
          logger.warn(`DrawingStore: 拆分共享绘图文件 ${src} 失败: ${(err as Error).message}`);
        }
      }
    }

    // 3. 文件名对齐标签，并把映射写回 DB。
    const targets = new Set<string>();
    for (const row of group) {
      const file = current.get(row.id);
      if (!file) continue;
      const title = (row.title ?? '').trim() || DEFAULT_DRAWING_TITLE;
      const target = allocateFileName(taskDir, drawingFileName(title), targets, file);
      targets.add(target);
      if (target !== file) {
        try {
          renameSync(join(taskDir, file), join(taskDir, target));
        } catch (err) {
          logger.warn(
            `DrawingStore: 修复绘图文件名失败 ${file} → ${target}: ${(err as Error).message}`,
          );
          continue;
        }
      }
      if (target !== row.path || title !== row.title) {
        this.db
          .prepare('UPDATE drawings SET title = ?, path = ? WHERE id = ?')
          .run(title, target, row.id);
      }
    }
  }

  private bestEffortUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      logger.warn(`DrawingStore best-effort unlink failed: ${(err as Error).message}`);
    }
  }
}