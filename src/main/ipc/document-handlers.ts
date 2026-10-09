// IPC handlers for document.* channels (schema v21: 文档就是文件)。
//
// 所有写操作(新建 / 保存 / 删除 / 改名)结尾都会 best-effort 地 git commit
// 一次**整个** todos/ 目录 —— 一次文档操作往往同时动好几个路径(正文文件、
// todo.json、缩略图、以及 git 需要知道的删除)，只提交单个文件会让仓库和
// 工作区慢慢对不上。commitAll 没东西可提交时不建 commit，git 不可用时静默
// 返回 null：git 失败绝不能让用户的保存失败。

import { BrowserWindow } from 'electron';
import { join, relative, sep } from 'node:path';
import { okResult, failResult, register } from './router';
import type { DocumentStore, LinkStore } from '../files/documents';
import * as gitHistory from '../git-history';
import { labelForFileName } from '../files/task-files';
import type { ULID } from '../../shared/todo-types';
import { logger } from '../logger';

/** Broadcast a content-scope data-changed so any open editor refetches its
 *  documents after a mutation (mirrors the todo/progress broadcast pattern). */
function broadcastDataChanged(scope: 'content'): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:data-changed', { scope });
  }
}

/** Resolver injected from src/main/index.ts so handlers don't reach back into
 *  the wiring layer. Mirrors the same closure given to MarkdownStore. */
export type ResolveTaskDir = (todoId: ULID) => string;

export function registerDocumentHandlers(
  docs: DocumentStore,
  links: LinkStore,
  resolveTaskDir: ResolveTaskDir,
  todosDir: string,
): void {
  // Best-effort: ensure the todos/ folder is a git repo with a local identity.
  // Failure is non-fatal — the renderer will see `available: false` and hide
  // the History button. Fire-and-forget: don't block the IPC router boot.
  // (content-handlers also calls this; both calls are idempotent.)
  void gitHistory.ensureGitRepo(todosDir).catch(() => {
    /* swallow — see comment above */
  });

  // git 记账：一次提交覆盖 todos/ 下的全部改动。没东西可提交时不建 commit，
  // git 不可用 / 提交失败时返回 null —— 一律吞掉，绝不让用户的保存失败。
  const commitAllToGit = (message: string): void => {
    void gitHistory.commitAll(todosDir, message).catch(() => {
      /* swallow — git is best-effort */
    });
  };

  // Resolve the git relPath (the doc's file relative to the todosDir repo
  // root). Forward slashes for git.
  const docRelPath = (todoId: ULID, fileName: string): string =>
    relative(todosDir, join(resolveTaskDir(todoId), fileName)).split(sep).join('/');

  register('document.list', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      // 确保进展文档存在 —— 覆盖 v11 迁移之后新建的任务(那个迁移只回填了
      // 迁移时已存在的任务)。
      docs.ensureDefaultDocs(req.todoId, taskDir);
      return Promise.resolve(okResult({ files: docs.listFiles(taskDir) }));
    } catch (err) {
      return Promise.resolve(failResult('document_list_failed', (err as Error).message));
    }
  });

  // 刷新按钮：清掉扫描缓存后重读目录，把用户在应用外新建 / 删除的文件
  // 显出来。DB 里没有需要 reconcile 的东西 —— 文件本身就是全部真相。
  register('document.refresh', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      return Promise.resolve(okResult({ files: docs.refreshFiles(taskDir) }));
    } catch (err) {
      return Promise.resolve(failResult('document_refresh_failed', (err as Error).message));
    }
  });

  register('document.create', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      const entry = docs.createNoteFile(taskDir, req.title ?? null);
      commitAllToGit(`新增文档 ${entry.label}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(entry));
    } catch (err) {
      return Promise.resolve(failResult('document_create_failed', (err as Error).message));
    }
  });

  register('document.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.read(req.todoId, req.fileName)));
    } catch (err) {
      return Promise.resolve(failResult('document_read_failed', (err as Error).message));
    }
  });

  register('document.write', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      // 先记版本再落文件：版本历史是用户输入的唯一一份拷贝，文件写失败
      // (只读盘 / 同步软件锁) 时至少内容还在，saveContent 里的 writeToFile
      // 是 best-effort 的。
      const res = docs.saveContent(taskDir, req.todoId, req.fileName, req.content, req.expectVersion);
      commitAllToGit(`保存文档 ${labelForFileName(req.fileName)}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(res));
    } catch (err) {
      const message = (err as Error).message;
      const isConflict = message.startsWith('version_conflict');
      return Promise.resolve(
        failResult(isConflict ? 'version_conflict' : 'document_write_failed', message),
      );
    }
  });

  register('document.rename', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      // 文件名就是标签：改名 = 搬文件。返回实际落地的文件名，标签跟着它走。
      const fileName = docs.renameFile(taskDir, req.fileName, req.title);
      if (fileName !== req.fileName) commitAllToGit(`重命名文档 ${labelForFileName(req.fileName)}`);
      return Promise.resolve(okResult({ fileName, label: labelForFileName(fileName) }));
    } catch (err) {
      return Promise.resolve(failResult('document_rename_failed', (err as Error).message));
    }
  });

  register('document.remove', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      docs.removeFile(taskDir, req.fileName);
      commitAllToGit(`删除文档 ${labelForFileName(req.fileName)}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('document_remove_failed', (err as Error).message));
    }
  });

  register('document.history', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.history(req.todoId, req.fileName)));
    } catch (err) {
      return Promise.resolve(failResult('document_history_failed', (err as Error).message));
    }
  });

  register('document.restoreVersion', (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      // 恢复也重新落一次盘，让 git 历史记录下这次恢复。
      const current = docs.read(req.todoId, req.fileName);
      docs.restoreVersion(req.todoId, req.fileName, req.versionId);
      docs.writeToFile(taskDir, req.fileName, docs.read(req.todoId, req.fileName).content);
      commitAllToGit(`恢复版本 ${labelForFileName(req.fileName)} v${current.version}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      const message = (err as Error).message;
      const isMissing = message.startsWith('version_not_found');
      return Promise.resolve(
        failResult(isMissing ? 'version_not_found' : 'document_restore_failed', message),
      );
    }
  });

  register('document.gitHistory', async (_e, req) => {
    try {
      const available = await gitHistory.gitAvailable();
      if (!available) return okResult({ available: false, entries: [] });
      const entries = (await gitHistory.getFileLog(todosDir, docRelPath(req.todoId, req.fileName))) ?? [];
      return okResult({ available: true, entries });
    } catch (err) {
      return failResult('git_history_failed', (err as Error).message);
    }
  });

  register('document.gitRestore', async (_e, req) => {
    try {
      const taskDir = resolveTaskDir(req.todoId);
      const content = await gitHistory.getFileAtSha(todosDir, docRelPath(req.todoId, req.fileName), req.sha);
      if (content == null) return failResult('git_restore_failed', `no content at ${req.sha}`);
      // 恢复出来的内容作为一个新版本写回(镜像到磁盘 + FTS 同步)，再提交，
      // 这样恢复本身也出现在历史里。
      docs.saveContent(taskDir, req.todoId, req.fileName, content);
      commitAllToGit(`从 git 恢复文档 ${labelForFileName(req.fileName)}`);
      broadcastDataChanged('content');
      return okResult(undefined as never);
    } catch (err) {
      return failResult('git_restore_failed', (err as Error).message);
    }
  });

  // ----- link.* -----
  //
  // 链接有自己的表 todo_links：它没有文件，所以吃不了「文件名 = 标签」那套
  // 规则，也就无法从任务目录推导出来。CRUD 都在这里。

  register('link.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(links.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('link_list_failed', (err as Error).message));
    }
  });

  register('link.add', (_e, req) => {
    try {
      const link = links.add(req.todoId, req.url, req.title ?? null, req.description ?? null);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(link));
    } catch (err) {
      return Promise.resolve(failResult('link_add_failed', (err as Error).message));
    }
  });

  register('link.remove', (_e, req) => {
    try {
      links.remove(req.id);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('link_remove_failed', (err as Error).message));
    }
  });

  logger.info('document.* + link.* handlers registered');
}
