// IPC handlers for content.* + drawing.* channels.

import { relative, sep } from 'node:path';
import { okResult, failResult, register } from './router';
import { broadcastDataChanged } from './broadcast';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type { TodoRepo } from '../db/todo-repo';
import { logger } from '../logger';
import * as gitHistory from '../git-history';
import * as paths from '../files/paths';
import type { ULID } from '../../shared/todo-types';

export function registerContentHandlers(
  md: MarkdownStore,
  drawings: DrawingStore,
  repo: TodoRepo,
): void {
  // todosDir lives on the MarkdownStore (constructed with it). Resolved here
  // once at boot so commitOnSave + the git history handlers share the path.
  const todosDir = md.todosDirPath;

  // Best-effort: ensure the todos/ folder is a git repo with a local identity.
  // Failure is non-fatal — the renderer will see `available: false` and hide
  // the History button. Fire-and-forget: don't block the IPC router boot.
  void gitHistory.ensureGitRepo(todosDir).catch(() => {
    /* swallow — see comment above */
  });

  // Resolve the git relPath (path of the progress doc relative to the
  // todosDir repo root) for a given todo. Post-refactor the file lives at
  // {todosDir}/{slug}/progress.md, so relPath = {slug}/progress.md.
  // We read it from the task dir MarkdownStore already resolves, so the
  // path tracks renames + collision suffixes without re-deriving the slug.
  const progressRelPath = (todoId: ULID): string => {
    const taskDir = md.filePathFor(todoId);
    // relative(todosDir, …/progress.md) → `{slug}/progress.md` with OS
    // separators; git wants forward slashes.
    return relative(todosDir, paths.progressFile(taskDir)).split(sep).join('/');
  };

  // Capture the repo in a closure so commitWriteToGit can look up the title
  // for the commit message without re-importing anything.
  const commitWriteToGit = async (todoId: ULID, version: number): Promise<void> => {
    try {
      if (!(await gitHistory.gitAvailable())) return;
      const title = repo.get(todoId)?.title ?? 'task';
      await gitHistory.commitOnSave(todosDir, progressRelPath(todoId), title, version);
    } catch {
      /* swallow — git is best-effort */
    }
  };

  // 绘图的新建 / 保存 / 删除 / 改名都会动磁盘上的文件，结束时要给整个
  // todos/ 目录记一次 git（缩略图、todo.json、删除都算在里面）。没东西可
  // 提交时不建 commit；失败静默 —— git 挂了绝不能让用户的编辑失败。
  const commitAllToGit = (message: string): void => {
    void gitHistory.commitAll(todosDir, message).catch(() => {
      /* swallow — git is best-effort */
    });
  };

  register('content.readBody', (_e, req) => {
    try {
      return Promise.resolve(okResult(md.readBody(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('read_failed', (err as Error).message));
    }
  });

  register('content.writeBody', (_e, req) => {
    try {
      const res = md.writeBody(req.id, req.markdown, req.expectVersion);
      // After a successful write, commit the file to git so the renderer's
      // History button has something to show. Best-effort: a failed commit
      // must NOT surface as a write failure to the user (the body is already
      // safely on disk + in the DB).
      void commitWriteToGit(req.id, res.version);
      // 进展正文之外的附带改动（todo.json 等）一并入库。
      commitAllToGit(`保存正文 ${repo.get(req.id)?.title ?? 'task'}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(res));
    } catch (err) {
      const message = (err as Error).message;
      const isConflict = message.startsWith('version_conflict');
      return Promise.resolve(
        failResult(isConflict ? 'version_conflict' : 'write_failed', message),
      );
    }
  });

  register('content.history', (_e, req) => {
    try {
      return Promise.resolve(okResult(md.history(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('history_failed', (err as Error).message));
    }
  });

  register('content.restoreVersion', (_e, req) => {
    try {
      md.restoreVersion(req.id, req.versionId);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('restore_failed', (err as Error).message));
    }
  });

  register('content.gitHistory', async (_e, req) => {
    try {
      const available = await gitHistory.gitAvailable();
      if (!available) return okResult({ available: false, entries: [] });
      const entries = (await gitHistory.getFileLog(todosDir, progressRelPath(req.id))) ?? [];
      return okResult({ available: true, entries });
    } catch (err) {
      return failResult('git_history_failed', (err as Error).message);
    }
  });

  register('content.gitRestore', async (_e, req) => {
    try {
      const ok = await gitHistory.restoreFileAtSha(todosDir, progressRelPath(req.id), req.sha);
      if (!ok) return failResult('git_restore_failed', `git restore failed for ${req.sha}`);
      // After a restore, the renderer re-reads the body via content.readBody.
      broadcastDataChanged('content');
      return okResult(undefined as never);
    } catch (err) {
      return failResult('git_restore_failed', (err as Error).message);
    }
  });

  register('drawing.list', (_e, req) => {
    try {
      return Promise.resolve(okResult(drawings.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('list_failed', (err as Error).message));
    }
  });

  register('drawing.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(drawings.read(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('read_failed', (err as Error).message));
    }
  });

  register('drawing.save', (_e, req) => {
    try {
      const meta = drawings.save(req.todoId, req.scene, req.id, req.title);
      commitAllToGit(`${req.id ? '保存' : '新增'}绘图 ${meta.title ?? '绘图'}`);
      // 必须广播：tab 列表现在是按目录扫描出来的（TaskFileIndex），绘图的新建 /
      // 改名 / 删除都会改变磁盘上的文件集合。不广播的话 useDocuments 不会重拉，
      // 用户就得手动点刷新才能看到自己刚建的绘图。
      broadcastDataChanged('content');
      return Promise.resolve(okResult(meta));
    } catch (err) {
      return Promise.resolve(failResult('save_failed', (err as Error).message));
    }
  });

  register('drawing.delete', (_e, req) => {
    try {
      const before = drawings.get(req.id);
      drawings.delete(req.id);
      commitAllToGit(`删除绘图 ${before?.title ?? req.id}`);
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('delete_failed', (err as Error).message));
    }
  });

  register('drawing.rename', (_e, req) => {
    try {
      drawings.rename(req.id, req.title);
      // Return the refreshed meta so the renderer can update the tab label
      // without a second round-trip (mirrors document.rename).
      const meta = drawings.get(req.id);
      if (!meta) return Promise.resolve(failResult('rename_failed', 'drawing not found after rename'));
      commitAllToGit(`重命名绘图 ${meta.title ?? req.id}`);
      // 改名搬动了文件，文件名就是标签 —— 列表要跟着重拉。
      broadcastDataChanged('content');
      return Promise.resolve(okResult(meta));
    } catch (err) {
      return Promise.resolve(failResult('rename_failed', (err as Error).message));
    }
  });

  register('drawing.setThumb', (_e, req) => {
    try {
      drawings.setThumb(req.id, req.dataUrl);
      // 缩略图也是 todos/ 下的文件，得跟着提交，否则工作区和仓库会分家。
      commitAllToGit('更新绘图缩略图');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('thumb_failed', (err as Error).message));
    }
  });

  logger.info('content.* + drawing.* handlers registered');
}