// IPC handlers for memo.* channels (备忘录, schema v21)。
//
// 拖入的碎片无法在 drop 那一刻预知是「一段记录」/「某个任务的进展」/
// 「一个新任务」，所以先落成 memo（memo.ingest / memo.create），用户随后
// 交互整理成三个动作之一：
//
//   ① 并入已有任务 (memo.mergeIntoTask) —— 正文追加进该任务的进展文档，
//      附件复制过去，memo 删除。
//   ② 变成新任务   (memo.promoteToTask) —— 建任务，正文作为它的进展，
//      附件转过去，memo 删除。
//   ③ 标记为纯记录 (memo.markResolved) —— 留在备忘录但折叠进「已整理」，
//      resolved_at 置位，不删除。
//
// 三条不变式（见 AGENTS.md）：
//   - 目标任务的 id 一律来自请求参数，绝不自己造；不存在就报错（不静默
//     建一个）。
//   - 正文永远写进任务的 progress 文档（DocumentStore.write），不直接改
//     todos.body —— write() 内部会把 progress 正文镜像回 todos.body 以保持
//     FTS5 external-content 表同步。
//   - 附件用 copyFileSync 转移而不是 move：合并中途失败时 memo 完整保留、
//     可重试；成功后 memo 整条删除，副本随任务走。

import { BrowserWindow } from 'electron';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { okResult, failResult, register } from './router';
import type { MemoStore } from '../files/memos';
import type { DocumentStore } from '../files/documents';
import type { InboxStore } from '../files/inbox';
import type { TodoRepo } from '../db/todo-repo';
import type { ResolveTaskDir } from './document-handlers';
import type { IpcResult, MemoFileRef } from '../../shared/ipc-schema';
import type { Memo, MemoSource, Todo, ULID } from '../../shared/todo-types';
import { logger } from '../logger';

// 与 pet-handlers 同一组上限 —— 拖进来的东西五花八门，限制保持一致，
// 免得用户在两个入口得到不同的行为。
const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_TEXT_BYTES = 50 * 1024; // 50 KB of plaintext

export interface MemoHandlerDeps {
  memos: MemoStore;
  docs: DocumentStore;
  todos: TodoRepo;
  inbox: InboxStore;
  resolveTaskDir: ResolveTaskDir;
}

/** 广播 memos 作用域的数据变更，让所有打开的窗口重拉备忘录列表。 */
function broadcastDataChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope: 'memos' });
  }
}

/** Best-effort mime from extension. Mirrors the helper in pet-handlers.ts —
 *  kept local so this module has no dependency on the main entrypoint's
 *  internals (mirrors that file's own reasoning). */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.h': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.hpp': 'text/x-c++',
    '.sh': 'text/x-shellscript',
    '.ps1': 'text/x-powershell',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function registerMemoHandlers(deps: MemoHandlerDeps): void {
  register('memo.list', (_e, req) => handleMemoList(deps, req));
  register('memo.get', (_e, req) => handleMemoGet(deps, req));
  register('memo.create', (_e, req) => handleMemoCreate(deps, req));
  register('memo.update', (_e, req) => handleMemoUpdate(deps, req));
  register('memo.remove', (_e, req) => handleMemoRemove(deps, req));
  register('memo.ingest', (_e, req) => handleMemoIngest(deps, req));
  register('memo.mergeIntoTask', (_e, req) => handleMemoMerge(deps, req));
  register('memo.promoteToTask', (_e, req) => handleMemoPromote(deps, req));
  register('memo.markResolved', (_e, req) => handleMemoResolve(deps, req));
  register('memo.readAttachment', (_e, req) => handleMemoReadAttachment(deps, req));
  logger.info('memo.* handlers registered');
}

// Each handler body is exported so unit tests can call it directly instead
// of going through the IPC router (which needs a live electron ipcMain).
// Same trade as pet-handlers.ts.

export function handleMemoList(
  deps: MemoHandlerDeps,
  req: { includeResolved?: boolean },
): IpcResult<Memo[]> {
  try {
    return okResult(deps.memos.list(req?.includeResolved ?? false));
  } catch (err) {
    return failResult('memo_list_failed', (err as Error).message);
  }
}

export function handleMemoGet(
  deps: MemoHandlerDeps,
  req: { id: string },
): IpcResult<Memo | null> {
  try {
    return okResult(deps.memos.get(req.id));
  } catch (err) {
    return failResult('memo_get_failed', (err as Error).message);
  }
}

export function handleMemoCreate(
  deps: MemoHandlerDeps,
  req: { content: string; source?: MemoSource; files?: MemoFileRef[] },
): IpcResult<Memo> {
  try {
    const memo = createWithFiles(deps, req.content, req.source ?? 'drop', req.files ?? []);
    broadcastDataChanged();
    return okResult(memo);
  } catch (err) {
    return failResult(codeFor(err), (err as Error).message);
  }
}

export function handleMemoUpdate(
  deps: MemoHandlerDeps,
  req: { id: string; content: string },
): IpcResult<Memo | null> {
  try {
    const memo = deps.memos.update(req.id, { content: req.content });
    if (!memo) return okResult(null);
    broadcastDataChanged();
    return okResult(memo);
  } catch (err) {
    return failResult('memo_update_failed', (err as Error).message);
  }
}

export function handleMemoRemove(
  deps: MemoHandlerDeps,
  req: { id: string },
): IpcResult<void> {
  try {
    deps.memos.remove(req.id);
    broadcastDataChanged();
    return okResult(undefined as never);
  } catch (err) {
    return failResult('memo_remove_failed', (err as Error).message);
  }
}

/** 拖拽快路径：有 targetTodoId 就直接并入那个任务（create + merge 一次
 *  做完），没有就只落一条 memo。少一次往返，也让「拖到任务行上」这个
 *  动作不产生用户根本不打算整理的碎片。 */
export function handleMemoIngest(
  deps: MemoHandlerDeps,
  req: { content: string; source?: MemoSource; files?: MemoFileRef[]; targetTodoId?: string | null },
): IpcResult<{ todoId: string | null; memoId: string | null }> {
  try {
    const memo = createWithFiles(deps, req.content, req.source ?? 'drop', req.files ?? []);
    if (req.targetTodoId) {
      mergeIntoTask(deps, memo, req.targetTodoId);
      broadcastDataChanged();
      return okResult({ todoId: req.targetTodoId, memoId: null });
    }
    broadcastDataChanged();
    return okResult({ todoId: null, memoId: memo.id });
  } catch (err) {
    return failResult(codeFor(err), (err as Error).message);
  }
}

export function handleMemoMerge(
  deps: MemoHandlerDeps,
  req: { id: string; todoId: string },
): IpcResult<{ todoId: string }> {
  try {
    const memo = deps.memos.get(req.id);
    if (!memo) return failResult('memo_not_found', `备忘录不存在: ${req.id}`);
    mergeIntoTask(deps, memo, req.todoId);
    broadcastDataChanged();
    return okResult({ todoId: req.todoId });
  } catch (err) {
    return failResult(codeFor(err), (err as Error).message);
  }
}

export function handleMemoPromote(
  deps: MemoHandlerDeps,
  req: { id: string; title?: string },
): IpcResult<{ todoId: string }> {
  try {
    const memo = deps.memos.get(req.id);
    if (!memo) return failResult('memo_not_found', `备忘录不存在: ${req.id}`);
    const todo = promoteToTask(deps, memo, req.title);
    broadcastDataChanged();
    return okResult({ todoId: todo.id });
  } catch (err) {
    return failResult(codeFor(err), (err as Error).message);
  }
}

/** 整理动作③：标记为纯记录。`resolved` 为 false 时撤销，条目回到待整理。 */
export function handleMemoResolve(
  deps: MemoHandlerDeps,
  req: { id: string; resolved: boolean },
): IpcResult<Memo | null> {
  try {
    const memo = deps.memos.update(req.id, {
      resolvedAt: req.resolved ? Date.now() : null,
    });
    if (!memo) return okResult(null);
    broadcastDataChanged();
    return okResult(memo);
  } catch (err) {
    return failResult('memo_resolve_failed', (err as Error).message);
  }
}

/** 附件字节以 data: URL 返回，渲染层永远拿不到绝对路径。 */
export function handleMemoReadAttachment(
  deps: MemoHandlerDeps,
  req: { id: string },
): IpcResult<{ dataUrl: string; mime: string; filename: string }> {
  try {
    return okResult(deps.memos.readAttachment(req.id));
  } catch (err) {
    return failResult('memo_read_attachment_failed', (err as Error).message);
  }
}

/** 建立一条 memo 并把拖入的文件挂上去。文本超长截断、文件数超限 /
  文件读不动都直接抛错（由调用方转成 failResult）—— 不做部分成功。 */
function createWithFiles(
  deps: MemoHandlerDeps,
  content: string,
  source: MemoSource,
  files: MemoFileRef[],
): Memo {
  const text = (content ?? '').slice(0, MAX_TEXT_BYTES);
  if (files.length > MAX_FILES) {
    throw new MemoError('too_many_files', `一次最多拖入 ${MAX_FILES} 个文件`);
  }
  if (!text && files.length === 0) {
    throw new MemoError('empty', '请至少拖入一个文件或输入文字');
  }
  const memo = deps.memos.create(text, source);
  for (const f of files) {
    if ('path' in f) {
      let size: number;
      try {
        size = statSync(f.path).size;
      } catch (err) {
        throw new MemoError('file_unreadable', `无法读取文件 ${f.name}: ${(err as Error).message}`);
      }
      if (size > MAX_FILE_BYTES) {
        throw new MemoError('file_too_large', `文件 ${f.name} 超过 50MB 上限`);
      }
      const mime = mimeFromExt(extname(f.path || f.name));
      deps.memos.attach(memo.id, f.path, mime);
    } else {
      // 浏览器里拖出的图：没有磁盘路径，只能解 data: URL。attachBlob 内部
      // 会再解一次并做大小兜底，这里先按声明的 size 粗筛。
      if (f.size != null && f.size > MAX_FILE_BYTES) {
        throw new MemoError('file_too_large', `文件 ${f.name} 超过 50MB 上限`);
      }
      const mime = f.mime || mimeFromExt(extname(f.name));
      deps.memos.attachBlob(memo.id, f.dataUrl, basename(f.name), mime);
    }
  }
  // 附件挂上后重投影一次，让 memo.json 的目录快照带上附件。
  deps.memos.writeProjection(memo);
  // 重读：attach 之后 attachmentIds 才完整。直接返回 create() 给的那个
  // 对象会让渲染层拿到 attachmentIds: [] 的过期快照，附件要等下一次
  // data-changed 才会出现。
  return deps.memos.get(memo.id)!;
}

/** 整理动作①：正文追加进目标任务的进展文档，附件复制过去，删 memo。
 *  目标任务的 id 来自调用方（要么用户选的，要么拖拽命中的行）—— 我们只
 *  校验它存在，不构造。 */
export function mergeIntoTask(deps: MemoHandlerDeps, memo: Memo, todoId: ULID): void {
  const todo = deps.todos.get(todoId);
  if (!todo) throw new MemoError('todo_not_found', `目标任务不存在: ${todoId}`);

  // 取（或建）该任务的 progress 文档。正文走 DocumentStore.write，它内部
  // 会把 progress 正文镜像回 todos.body 以保持 FTS5 同步 —— 所以不要直接
  // UPDATE todos.body，那会绕过触发器。
  deps.docs.ensureDefaultDocs(todoId);
  const progress = deps.docs.list(todoId).find((d) => d.kind === 'progress');
  if (!progress) throw new MemoError('progress_doc_missing', `任务 ${todoId} 缺少进展文档`);

  const { content: current, version } = deps.docs.read(progress.id);
  const stamped = stampAppend(current, memo);
  deps.docs.write(progress.id, stamped, version);
  deps.docs.writeToFile(deps.resolveTaskDir(todoId), 'progress', '进展', stamped);

  // 附件复制进任务的附件区。copy 而非 move：中途失败时 memo 还在，可重试。
  for (const attach of deps.memos.listAttachments(memo.id)) {
    deps.inbox.attach(todoId, attach.filePath, attach.mime);
  }

  deps.memos.remove(memo.id);
}

/** 整理动作②：变成新任务。正文作为该任务的进展，附件转过去，删 memo。
 *  标题缺省用 preview（memo 自己的第一行摘要），实在没有就退回「未命名
 *  片段」—— 仍然让用户后续在任务里改名。 */
export function promoteToTask(
  deps: MemoHandlerDeps,
  memo: Memo,
  title?: string,
): Todo {
  const name = (title ?? memo.preview ?? '').trim() || '未命名片段';
  const todo = deps.todos.create({ title: name });
  deps.docs.ensureDefaultDocs(todo.id);
  const progress = deps.docs.list(todo.id).find((d) => d.kind === 'progress');
  if (progress) {
    // 新任务的进展 = memo 的原文（不做 stamp 前缀：此刻它就是全部内容，
    // 前面加一段「碎片整理于…」只是噪音）。
    const body = memo.content.trim();
    if (body) {
      deps.docs.write(progress.id, body);
      deps.docs.writeToFile(deps.resolveTaskDir(todo.id), 'progress', '进展', body);
    }
  }
  for (const attach of deps.memos.listAttachments(memo.id)) {
    deps.inbox.attach(todo.id, attach.filePath, attach.mime);
  }
  deps.memos.remove(memo.id);
  return todo;
}

/** 把 memo 正文追加到已有正文后面，用一条带日期的分隔线隔开，让多次
 *  并入在文档里读起来是时间线而不是糊成一坨。空 memo（只有附件）不写
 *  分隔线 —— 那次并入只落附件。 */
function stampAppend(current: string, memo: Memo): string {
  const body = memo.content.trim();
  const when = new Date(memo.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const head = current.trim()
    ? `${current.replace(/\s+$/, '')}\n\n---\n\n## 整理自备忘录 · ${when}\n\n`
    : `## 整理自备忘录 · ${when}\n\n`;
  return body ? `${head}${body}\n` : `${current}${current ? '\n' : ''}`;
}

/** 带 error code 的内部异常。`codeFor` 把它映射成 IPC 的 failResult
 *  code，其余一律 memo_operation_failed。 */
class MemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemoError';
  }
}

function codeFor(err: unknown): string {
  return err instanceof MemoError ? err.code : 'memo_operation_failed';
}
