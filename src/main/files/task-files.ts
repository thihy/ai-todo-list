// TaskFileIndex —— 任务目录里的文件清单,tab 列表的唯一真相。
//
// 为什么文件说了算:标签和文件名是同一个东西(除了 progress.md),所以
// 「有哪些文档」这件事问文件系统就够了。让 DB 再存一份映射,两份数据迟早
// 不一致,而且不一致的时候没人知道该信谁 —— 这正是之前 task_documents
// 表想解决的问题,但它只是把「名字存哪」换了个地方,没消除双份真相。
// schema v21 把那张表删掉了;DB 只剩 document_versions(版本历史)和
// drawings.path / todo_links(各有归属)。
//
// IO:list() 会真读磁盘,所以加了缓存。缓存按 taskDir 分桶,写入路径上
// 主动 invalidate,外部改动靠刷新按钮清缓存后重读。

import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DocumentKind, TaskFileEntry } from '../../shared/todo-types';
import { PROGRESS_FILE_NAME } from './paths';

export type { DocumentKind, TaskFileEntry };

export interface TaskFileListing {
  files: TaskFileEntry[];
  /** Directory mtime at scan time; 0 when the dir itself is unreadable. */
  scannedAtMs: number;
}

/** 非用户文档的文件/目录,直接忽略。 */
function isIgnored(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true; // .git / .DS_Store
  if (isDir) return true; // thumbs/ attachments/
  if (name === 'todo.json') return true; // 任务元数据快照,不是文档
  return false;
}

function classify(fileName: string): { kind: DocumentKind; label: string } | null {
  if (fileName === PROGRESS_FILE_NAME) {
    // 唯一的例外:进展文档的文件名固定为 progress.md,和标签无关,
    // 也永远不会因为撞名而变成 progress_1.md。
    return { kind: 'progress', label: '进展' };
  }
  if (fileName.endsWith('.md')) {
    return { kind: 'note_md', label: fileName.slice(0, -'.md'.length) };
  }
  if (fileName.endsWith('.excalidraw')) {
    return { kind: 'drawing', label: fileName.slice(0, -'.excalidraw'.length) };
  }
  return null;
}

export class TaskFileIndex {
  /** taskDir → 扫描结果。null 值表示「扫过但目录读不到」。 */
  private cache = new Map<string, TaskFileListing | null>();

  constructor(
    /** 扫描结果最多活多久(ms)。写入路径会主动 invalidate,所以这个 TTL
     *  只用来兜住「用户在应用外改了目录」的情况。默认 5s。 */
    private ttlMs = 5_000,
    private now: () => number = Date.now,
  ) {}

  /** 任务目录里的文档清单(缓存)。 */
  list(taskDir: string): TaskFileEntry[] {
    return this.read(taskDir)?.files ?? [];
  }

  /** 按文件名取一条,找不到返回 null。 */
  find(taskDir: string, fileName: string): TaskFileEntry | null {
    return this.list(taskDir).find((f) => f.fileName === fileName) ?? null;
  }

  /** 目录里已被占用的文件名。分配新文件名时传给 allocateFileName() 的
   *  `taken` —— 它会再和文件系统的实况取交集,所以**用户在应用外丢进来的
   *  文件同样不会被覆盖**。 */
  takenNames(taskDir: string): Set<string> {
    return new Set(this.list(taskDir).map((f) => f.fileName));
  }

  /** 让一个任务目录的缓存失效。写入 / 删除文件后必须调用。 */
  invalidate(taskDir: string): void {
    this.cache.delete(taskDir);
  }

  /** 清掉全部缓存 —— 刷新按钮走这条。 */
  invalidateAll(): void {
    this.cache.clear();
  }

  private read(taskDir: string): TaskFileListing | null {
    const hit = this.cache.get(taskDir);
    const t = this.now();
    if (hit !== undefined && hit !== null && t - hit.scannedAtMs < this.ttlMs) return hit;

    const listing = this.scan(taskDir);
    this.cache.set(taskDir, listing);
    return listing;
  }

  private scan(taskDir: string): TaskFileListing | null {
    let dirents;
    try {
      dirents = readdirSync(taskDir, { withFileTypes: true });
    } catch {
      // 目录还不存在(新建任务第一次打开)或读不了。当作空清单,
      // 调用方照常创建文件即可。
      this.cache.set(taskDir, null);
      return null;
    }
    const files: TaskFileEntry[] = [];
    for (const dirent of dirents) {
      if (isIgnored(dirent.name, dirent.isDirectory())) continue;
      const kind = classify(dirent.name);
      if (!kind) continue;
      let sizeBytes: number;
      let mtimeMs: number;
      try {
        const st = statSync(join(taskDir, dirent.name));
        sizeBytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // 扫描途中被删掉了(另一个进程/同步软件),跳过即可。
        continue;
      }
      files.push({ fileName: dirent.name, label: kind.label, kind: kind.kind, sizeBytes, mtimeMs });
    }
    // 排序让 tab 顺序稳定:进展第一(ord 0),其余按标签名。
    files.sort((a, b) => {
      if (a.kind === 'progress') return -1;
      if (b.kind === 'progress') return 1;
      return a.label.localeCompare(b.label, 'zh-Hans-CN');
    });
    return { files, scannedAtMs: this.now() };
  }
}

/** 文件名 → 标签(和 classify 保持一致,供分配器复用)。 */
export function labelForFileName(fileName: string): string {
  return classify(fileName)?.label ?? basename(fileName);
}