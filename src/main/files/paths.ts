// Per-task 路径数学（slug + 文件名）。
//
// 重构后所有 store / handler 都从 todo / 文档 / 绘图标题算出在磁盘上的位置：
//   {dataDir}/todos/{slug}/
//     todo.json
//     progress.md
//     {docName}.md
//     {docName}.excalidraw
//     thumbs/{drawingId}.thumb.png
//     attachments/{uuid}-{name}
//
// 这些函数是"看得见但要小心的"：被用户输入直接驱动（标题、文件名），
// 不能让任何 input 走出 OS 文件名安全的边界。slugify() 是核心入口。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 用户标题最长保留多少个码点。20 个汉字 ≈ 60 UTF-8 字节，离 NTFS 255 字节
 *  限制还很远，给目录名 + 文件名后缀留足空间。 */
export const SLUG_MAX_CHARS = 20;

/** slugify() 输入为空或清洗后为空时的兜底值。 */
export const UNTITLED_SLUG = 'untitled';

/** 把用户标题清洗成安全的目录 / 文件名组件。
 *
 *  规则：
 *   1. 截断到 SLUG_MAX_CHARS 个 Unicode 码点（不是字节），丢掉孤立的 high
 *      surrogate，避免 BMP 之外的 emoji 被切到一半。
 *   2. 把 Windows 非法字符、控制字符、NUL 替换成 '_'。
 *   3. 把连续空白压缩成单个 '_'，再去掉首尾的 '.' / 空格 / '_'（Windows
 *      视末尾的 '.' 为非法，且大小写不敏感下"."也算结束）。
 *   4. 命中 Windows 保留名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9）
 *      时追加一个下划线，否则会被文件系统拒绝。
 *   5. 清洗结果为空时返回 UNTITLED_SLUG。
 *
 *  返回值保证：
 *   - 非空
 *   - 不含 Windows 非法字符
 *   - 首尾不是 '.' / 空格 / '_'
 *   - 长度 ≤ SLUG_MAX_CHARS
 */
export function slugify(title: string): string {
  // 1. 截断到 N 个码点；丢弃孤立的 high surrogate（保留成对的 surrogate pair）。
  const codepoints = Array.from(title.trim());
  const sliced: number[] = [];
  for (let i = 0; i < codepoints.length && sliced.length < SLUG_MAX_CHARS; i++) {
    const cp = codepoints[i]!.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = codepoints[i + 1]?.codePointAt(0) ?? 0;
      // 高代理 + 紧随其后的低代理 → 合法 surrogate pair，保留
      if (next >= 0xdc00 && next <= 0xdfff) {
        sliced.push(cp, next);
        i++; // 跳过低代理，下次循环 i++ 时跳过
        continue;
      }
      // 孤立的 high surrogate（没有成对的 low surrogate）—— 丢弃
      continue;
    }
    sliced.push(cp);
  }
  const head = String.fromCodePoint(...sliced);

  // 2-3. Windows 非法字符、控制字符、空白、首尾 '.' / '_' / 空格
  const cleaned = head
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[.\s_]+|[.\s_]+$/g, '');

  // 4. 命中 Windows 保留名 → 加 '_' 后缀避开
  let safe = cleaned;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) {
    safe = `${safe}_`;
  }
  // 5. 兜底
  return safe || UNTITLED_SLUG;
}

/** Deterministic collision-free directory name. The first six todo-id
 * characters identify the task; the slug keeps the directory readable. */
export function uniqueTodoDir(todosDir: string, slug: string, ulid: string): string {
  return join(todosDir, `${ulid.slice(0, 6)}-${slug}`);
}

/** 解析"这个 TODO 的目录"并按需创建。
 *
 *  调用方传 (todosDir, repo.get(id).title, id)。返回的目录已经在磁盘上
 *  存在（或刚刚被 mkdirSync 创建）。调用方可以放心往里面写文件。
 *
 *  title 缺失时回退到 UNTITLED_SLUG（同名的两个"未命名 TODO"会落到不同
 *  ULID-suffix 目录里）。
 */
export function todoDir(todosDir: string, title: string, ulid: string): string {
  const dir = uniqueTodoDir(todosDir, slugify(title ?? UNTITLED_SLUG), ulid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 进展文档固定路径。progress.md 在每个 task 目录里只有一个，所以
 *  标题不参与命名——这是和 note_md / drawing 的最大区别。
 *  内容为 Markdown，磁盘投影仅作 git 历史/文件管理器之用，DB 才是权威。 */
export function progressFile(taskDir: string): string {
  return join(taskDir, 'progress.md');
}

/** 文档（kind=note_md）路径：按文档标题的 slug 加 .md。 */
export function noteFile(taskDir: string, docTitle: string): string {
  return join(taskDir, `${slugify(docTitle)}.md`);
}

/** 绘图文档路径：按绘图标题的 slug 加 .excalidraw（注意官方扩展名是
 *  excalidraw 不是 excaldraw）。 */
export function drawingFile(taskDir: string, drawingTitle: string): string {
  return join(taskDir, `${slugify(drawingTitle)}.excalidraw`);
}

/** 绘图缩略图路径：放在 taskDir/thumbs/ 子目录里。thumbs 命名跟 drawing id
 *  走（不跟 title）—— 标题改名不该重命名缓存文件。 */
export function thumbFile(taskDir: string, drawingId: string): string {
  return join(taskDir, 'thumbs', `${drawingId}.thumb.png`);
}

/** 附件子目录路径。 */
export function attachmentDir(taskDir: string): string {
  return join(taskDir, 'attachments');
}

/** 给定 taskDir + 附件相对文件名（一般是 `${ulid}-${sanitizedName}`），返回
 *  完整路径并按需创建 attachments 子目录。 */
export function attachmentFile(taskDir: string, uuidName: string): string {
  const dir = attachmentDir(taskDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, uuidName);
}

/** taskDir/todo.json —— 任务元数据的快照镜像（DB 才是真相，文件是备份）。 */
export function todoJsonPath(taskDir: string): string {
  return join(taskDir, 'todo.json');
}

// ---------- 备忘录 (schema v21) ----------
//
// 布局：
//   {dataDir}/memos/{ulid6}-{slug}/
//     memo.md
//     memo.json
//     attachments/{attachmentId}-{name}
//
// 与 TaskDirectoryStore 的关键差异（务必读完再改）：
// 任务目录的「id → 目录名」关联**持久化在 todos.storage_dir**，因为任务
// 会被改名，目录必须保持稳定（AGENTS.md 非目标事项 2/4）。memo 没有改名
// 语义 —— preview 由 content 首行派生，用户改的是 content 而不是
// preview，所以目录名可以每次从 id + preview 现算，不会漂移。
//
// 如果将来给 memo 加了「重命名」功能，就必须像 TaskDirectoryStore 一样
// 把目录名 hoist 进 DB（或加一个 rename 钩子），否则改完名旧目录会变成
// 孤儿。

/** 备忘片段落目录。slug 只为可读性；id 前 6 位保证唯一。 */
export function memoDir(memosDir: string, id: string, preview: string): string {
  const dir = join(memosDir, `${id.slice(0, 6)}-${slugify(preview || '备忘')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 备忘录正文投影（Markdown）。 */
export function memoFile(memoDirPath: string): string {
  return join(memoDirPath, 'memo.md');
}

/** 备忘录元数据快照（DB 才是真相，文件是备份）。 */
export function memoJsonPath(memoDirPath: string): string {
  return join(memoDirPath, 'memo.json');
}

/** 备忘录附件路径：memoDir/attachments/{id}-{name}，按需创建子目录。 */
export function memoAttachmentFile(memoDirPath: string, idName: string): string {
  const dir = join(memoDirPath, 'attachments');
  mkdirSync(dir, { recursive: true });
  return join(dir, idName);
}
