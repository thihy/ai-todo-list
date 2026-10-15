// DocumentStore —— 一个任务有哪些文档，由任务目录里的文件说了算(schema v21)。
//
// 为什么文件说了算:标签和文件名是同一个东西(除了 progress.md)。既然如此，
// 「有哪些文档 / 叫什么名字」就是目录扫描的结果，DB 再存一份映射只是多一
// 个会打架的真相。v21 把 task_documents 删掉了,现在 DB 只剩两样东西:
//   - document_versions:文本的**版本历史**,按 (todo_id, file_name) 索引 ——
//     文件名才是文档的稳定身份(标签会改,文件名只在重命名时变)。
//   - todo_links / drawings.path / inbox_attachments:各有归属,不是文档。
//
// 不变量(改代码前先读):
//   1. 文件名 == 标签(除了 progress.md,它的文件名固定 progress.md、
//      标签固定「进展」,既不重命名也不参与 _N 递增)。
//   2. 绝不覆盖已有文件。撞名就 _1 / _2 递增,而且分配到的名字**同时**
//      就是新的标签 —— 用户看到的是「第 2 个同名文档」。
//   3. 先写文件，再写 DB 索引/版本行。删除时先删文件。改名是搬文件。
//   4. 列表来自目录扫描，带缓存；刷新按钮清缓存后重读。
//
// 写文件是 best-effort 的:文件操作一律 try/catch + logger.warn 吞掉。DB 里
// 的版本历史不能因为磁盘满 / 只读盘 / 同步软件锁文件而写失败 —— 那会让用户
// 的输入凭空消失。

import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../db/schema';
import type {
  DocumentVersionEntry,
  TaskFileEntry,
  TodoLink,
  ULID,
} from '../../shared/todo-types';
import { MAX_BODY_VERSIONS } from '../../shared/constants';
import {
  allocateFileName,
  DEFAULT_NOTE_TITLE,
  noteFileName,
  PROGRESS_FILE_NAME,
} from './paths';
import { TaskFileIndex } from './task-files';
import { logger } from '../logger';

/** v11 迁移给旧任务自动建的 note_md 标签。用户自己建的叫「文档」，
 *  只有这个「笔记」是迁移产物，需要被吸收进展文档。 */
const LEGACY_NOTE_TITLE = '笔记';
const LEGACY_NOTE_FILE = `${LEGACY_NOTE_TITLE}.md`;

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

export class DocumentStore {
  constructor(
    private db: Database.Database,
    /** 任务目录里的文件清单 —— tab 列表的唯一真相。整个进程共用一个实例，
     *  这样「分配文件名 → 扫描」看到的是同一份状态,不会自己撞自己。 */
    private files: TaskFileIndex = new TaskFileIndex(),
  ) {}

  /** 这个任务目录当前占用的所有文件名(进展/文档/绘图)。分配新名字时用。 */
  takenNames(taskDir: string): Set<string> {
    return this.files.takenNames(taskDir);
  }

  /** 同上，但**排除**正在改名的那个文件自己。
   *
   *  allocateFileName 的 taken 语义是「别人已占用的名字」——把文件名传进去
   *  当 selfFile 逃生口用。不先摘掉自己的话，把文档改名成它现在的名字会被
   *  判成撞名，凭空变成 `B_1.md` / `B_2.md`。DrawingStore 走
   *  claimedPaths(todoId, exceptId) 是同一个道理。 */
  private otherNames(taskDir: string, exceptFileName: string): Set<string> {
    const names = this.files.takenNames(taskDir);
    names.delete(exceptFileName);
    return names;
  }

  // --- 文件即文档 -------------------------------------------------------

  /** 任务目录里的文档清单。progress.md 排在第一(和磁盘扫描的排序一致)。
   *  目录本身就是「这个任务有哪些文档」的全部答案，所以不需要 todoId ——
   *  拿到目录就够了。 */
  listFiles(taskDir: string): TaskFileEntry[] {
    return this.files.list(taskDir);
  }

  /** 清掉扫描缓存 + 重读。刷新按钮走这条，用来发现用户在应用外新建/删除的
   *  文件。 */
  refreshFiles(taskDir: string): TaskFileEntry[] {
    this.files.invalidate(taskDir);
    return this.files.list(taskDir);
  }

  /** 新建一篇 Markdown 文档:**先在磁盘上建文件**，标签就是分配到的文件名
   *  （去掉扩展名）。撞名时递增成 文档_1 / 文档_2，绝不覆盖已有文件 ——
   *  之前同名文档共用一个 .md，新建一张会把前一张的内容写穿。
   *
   *  返回的 entry.fileName 是实际落地的文件名，UI 直接用它当身份。 */
  createNoteFile(taskDir: string, title?: string | null): TaskFileEntry {
    const label = (title ?? '').trim() || DEFAULT_NOTE_TITLE;
    // 占用判断同时看目录扫描和文件系统实况：用户在应用外丢进来的文件同样
    // 不能被覆盖。
    const fileName = allocateFileName(taskDir, noteFileName(label), this.files.takenNames(taskDir));

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, fileName), '', 'utf8');
    this.files.invalidate(taskDir);

    return this.files.find(taskDir, fileName)!;
  }

  /** 删除任务目录里的一个文档文件（含绘图）。磁盘是真相，所以「删文档」
   *  就是删文件；best-effort，失败只记日志。 */
  removeFile(taskDir: string, fileName: string): void {
    try {
      if (existsSync(join(taskDir, fileName))) unlinkSync(join(taskDir, fileName));
      this.files.invalidate(taskDir);
    } catch (err) {
      logger.warn(`DocumentStore.removeFile(${fileName}) failed: ${(err as Error).message}`);
    }
  }

  /** 改名 = 搬文件，返回**实际落地的文件名**。
   *
   *  - progress.md 原地不动（标签固定「进展」，文件名固定 progress.md）；
   *  - 目标已被占用时递增成 {新标签}_1，绝不覆盖对方；
   *  - 搬运失败时返回原文件名：旧文件还在，文档仍然读得到。
   *
   *  因为标签就是文件名，这里没有「名字改成 A、文件还在叫 B」的中间态 ——
   *  搬不动就等于没改名。 */
  renameFile(taskDir: string, fileName: string, newTitle: string): string {
    if (fileName === PROGRESS_FILE_NAME) return PROGRESS_FILE_NAME;
    const from = join(taskDir, fileName);
    if (!existsSync(from)) return fileName;
    const target = allocateFileName(taskDir, noteFileName(newTitle), this.otherNames(taskDir, fileName), fileName);
    if (target === fileName) return fileName;
    try {
      renameSync(from, join(taskDir, target));
      this.files.invalidate(taskDir);
      return target;
    } catch (err) {
      logger.warn(`DocumentStore.renameFile(${fileName} → ${target}) failed: ${(err as Error).message}`);
      return fileName;
    }
  }

  /** 把内容镜像到磁盘上的那个文件。best-effort —— 见文件头注释。 */
  writeToFile(taskDir: string, fileName: string, content: string): void {
    try {
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, fileName), content, 'utf8');
      this.files.invalidate(taskDir);
    } catch (err) {
      logger.warn(`DocumentStore.writeToFile(${fileName}) failed: ${(err as Error).message}`);
    }
  }

  /** 确保任务有进展文档、桥接旧正文、吸收迁移遗留的「笔记」。幂等。 */
  ensureDefaultDocs(todoId: ULID, taskDir: string): void {
    mkdirSync(taskDir, { recursive: true });
    // progress.md 是固定名：不存在就建一个空的，不参与撞名递增。
    if (!existsSync(join(taskDir, PROGRESS_FILE_NAME))) {
      writeFileSync(join(taskDir, PROGRESS_FILE_NAME), this.latestContent(todoId, PROGRESS_FILE_NAME) ?? '', 'utf8');
      this.files.invalidate(taskDir);
    }

    // 进展文档还没有任何版本时，把旧的 content_versions 正文搬过来。
    // 判空条件和 v11 迁移一致 —— todo.create 会写一条空 body 的
    // content_versions，那条空行不能把进展文档填成一个空白文档。
    const progCount = this.db
      .prepare<[ULID, string], { c: number }>(
        'SELECT COUNT(*) as c FROM document_versions WHERE todo_id = ? AND file_name = ?',
      )
      .get(todoId, PROGRESS_FILE_NAME);
    if (progCount && progCount.c === 0) {
      const legacy = this.db
        .prepare<[ULID], { c: number }>(
          "SELECT COUNT(*) as c FROM content_versions WHERE todo_id = ? AND body != ''",
        )
        .get(todoId);
      if (legacy && legacy.c > 0) {
        this.bridgeLegacyBody(todoId, taskDir);
      }
    }

    this.absorbLegacyNote(todoId, taskDir);
  }

  /** 旧 content_versions 的正文 → 进展文档的第一版（按时间正序插入，
   *  最后一条落在最新）。顺带把 todos.body 和 progress.md 拉齐。 */
  private bridgeLegacyBody(todoId: ULID, taskDir: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO document_versions (todo_id, file_name, content, saved_at)
           SELECT ?, ?, body, saved_at FROM content_versions WHERE todo_id = ? ORDER BY id ASC`,
        )
        .run(todoId, PROGRESS_FILE_NAME, todoId);
      const latest = this.db
        .prepare<[ULID, string], { saved_at: number | null }>(
          'SELECT MAX(saved_at) as saved_at FROM document_versions WHERE todo_id = ? AND file_name = ?',
        )
        .get(todoId, PROGRESS_FILE_NAME);
      if (latest?.saved_at) {
        this.db
          .prepare('UPDATE todos SET body = ?, updated_at = ? WHERE id = ?')
          .run(this.latestContent(todoId, PROGRESS_FILE_NAME) ?? '', latest.saved_at, todoId);
      }
    });
    tx();
    // 正文现在归进展文档管，磁盘上的 progress.md 也要跟上(git 历史 / 文件
    // 资源管理器看的是文件)。
    this.writeToFile(taskDir, PROGRESS_FILE_NAME, this.latestContent(todoId, PROGRESS_FILE_NAME) ?? '');
  }

  /** 把 v11 迁移留下的 笔记.md 折进进展文档，然后删掉那个文件。
   *  用户自己建的文档（标签不同）不受影响。 */
  private absorbLegacyNote(todoId: ULID, taskDir: string): void {
    if (!existsSync(join(taskDir, LEGACY_NOTE_FILE))) return;
    const entry = this.files.find(taskDir, LEGACY_NOTE_FILE);
    const note = entry ? this.latestContent(todoId, LEGACY_NOTE_FILE) : null;
    if (note) {
      const progLatest = this.latestContent(todoId, PROGRESS_FILE_NAME);
      // 只在「笔记里确实有进展文档还没收录的内容」时才追加，避免和上面的
      // 旧正文桥接重复一遍。
      if (note !== progLatest) {
        this.db
          .prepare(
            `INSERT INTO document_versions (todo_id, file_name, content, saved_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(todoId, PROGRESS_FILE_NAME, note, Date.now());
        this.writeToFile(taskDir, PROGRESS_FILE_NAME, this.latestContent(todoId, PROGRESS_FILE_NAME) ?? '');
      }
    }
    this.removeFile(taskDir, LEGACY_NOTE_FILE);
  }

  // --- 版本化文本 -------------------------------------------------------

  private latestContent(todoId: ULID, fileName: string): string | null {
    return (
      this.db
        .prepare<[ULID, string], { content: string | null }>(
          `SELECT content FROM document_versions
           WHERE todo_id = ? AND file_name = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(todoId, fileName)?.content ?? null
    );
  }

  /** 读一个文档的最新版本。从未写过的文档返回 { content: '', version: 0 }。 */
  read(todoId: ULID, fileName: string): { content: string; version: number } {
    const row = this.db
      .prepare<[ULID, string], { id: number; content: string }>(
        `SELECT id, content FROM document_versions
         WHERE todo_id = ? AND file_name = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(todoId, fileName);
    return row ? { content: row.content, version: row.id } : { content: '', version: 0 };
  }

  /** 追加一个新版本。expectVersion 开启乐观并发(和 MarkdownStore.writeBody
   *  同一套方案)，冲突时抛 `version_conflict: …`，由 IPC 层转成
   *  version_conflict 错误码。保留最近 MAX_BODY_VERSIONS 个版本。 */
  write(
    todoId: ULID,
    fileName: string,
    content: string,
    expectVersion?: number,
  ): { version: number; updatedAt: number } {
    if (expectVersion != null) {
      const current = this.db
        .prepare<[ULID, string], { v: number | null }>(
          'SELECT MAX(id) as v FROM document_versions WHERE todo_id = ? AND file_name = ?',
        )
        .get(todoId, fileName)?.v ?? 0;
      if (current !== expectVersion) {
        throw new Error(`version_conflict: expected ${expectVersion}, current ${current}`);
      }
    }
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO document_versions (todo_id, file_name, content, saved_at) VALUES (?, ?, ?, ?)',
        )
        .run(todoId, fileName, content, now);
      // 只保留最近 MAX_BODY_VERSIONS 个版本(id 越大越新)。
      this.db
        .prepare(
          `DELETE FROM document_versions
           WHERE todo_id = ? AND file_name = ? AND id NOT IN (
             SELECT id FROM document_versions WHERE todo_id = ? AND file_name = ?
             ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(todoId, fileName, todoId, fileName, MAX_BODY_VERSIONS);
      // 进展文档就是任务的主正文 —— 把它镜像到 todos.body，FTS5 的
      // external-content 表读的正是这一列(search 的摘要片段靠它)。其余
      // 文档是次要的，刻意不进 FTS。
      if (fileName === PROGRESS_FILE_NAME) {
        this.db
          .prepare('UPDATE todos SET body = ?, updated_at = ? WHERE id = ?')
          .run(content, now, todoId);
      }
    });
    tx();
    const version = this.db
      .prepare<[ULID, string], { v: number | null }>(
        'SELECT MAX(id) as v FROM document_versions WHERE todo_id = ? AND file_name = ?',
      )
      .get(todoId, fileName)?.v ?? 0;
    return { version, updatedAt: now };
  }

  history(todoId: ULID, fileName: string): DocumentVersionEntry[] {
    return this.db
      .prepare<[ULID, string], { id: number; todo_id: string; file_name: string; content: string; saved_at: number }>(
        `SELECT id, todo_id, file_name, content, saved_at FROM document_versions
         WHERE todo_id = ? AND file_name = ? ORDER BY saved_at DESC`,
      )
      .all(todoId, fileName)
      .map((r) => ({
        id: r.id,
        todoId: r.todo_id,
        fileName: r.file_name,
        content: r.content,
        savedAt: r.saved_at,
      }));
  }

  restoreVersion(todoId: ULID, fileName: string, versionId: number): void {
    const v = this.db
      .prepare<[ULID, string, number], { content: string }>(
        `SELECT content FROM document_versions
         WHERE todo_id = ? AND file_name = ? AND id = ?`,
      )
      .get(todoId, fileName, versionId);
    if (!v) throw new Error(`version_not_found: ${versionId}`);
    this.write(todoId, fileName, v.content);
  }

  /** 写完正文顺手镜像到磁盘 + 清扫描缓存。写文件的顺序是「先落文件，
   *  再更新缓存」：缓存里永远不该出现一个还不存在的文件。 */
  saveContent(
    taskDir: string,
    todoId: ULID,
    fileName: string,
    content: string,
    expectVersion?: number,
  ): { version: number; updatedAt: number } {
    const res = this.write(todoId, fileName, content, expectVersion);
    this.writeToFile(taskDir, fileName, content);
    return res;
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
