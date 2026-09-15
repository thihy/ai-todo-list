// IPC handlers for document.* channels (multi-document workspace, schema v11).

import { BrowserWindow } from 'electron';
import { relative, sep } from 'node:path';
import { okResult, failResult, register } from './router';
import type { DocumentStore } from '../files/documents';
import * as gitHistory from '../git-history';
import * as paths from '../files/paths';
import type { TaskDocument, ULID } from '../../shared/todo-types';
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

  // Resolve the git relPath (path of the doc's file relative to the todosDir
  // repo root) for a given document. Progress → {slug}/progress.md;
  // note_md → {slug}/{slugified-title}.md. Forward slashes for git.
  const docRelPath = (doc: TaskDocument): string => {
    const taskDir = resolveTaskDir(doc.todoId);
    const abs =
      doc.kind === 'progress'
        ? paths.progressFile(taskDir)
        : paths.noteFile(taskDir, doc.title ?? '');
    return relative(todosDir, abs).split(sep).join('/');
  };

  // Best-effort commit after a write/restore. Swallowed on every error path so
  // a failed git commit never surfaces as a write failure (content is already
  // safe on disk + in the DB).
  const commitDocToGit = async (doc: TaskDocument, version: number): Promise<void> => {
    try {
      if (!(await gitHistory.gitAvailable())) return;
      if (doc.kind !== 'progress' && doc.kind !== 'note_md') return;
      await gitHistory.commitOnSave(todosDir, docRelPath(doc), doc.title ?? doc.kind, version);
    } catch {
      /* swallow — git is best-effort */
    }
  };

  register('document.list', (_e, req) => {
    try {
      // Ensure the default progress doc exists — covers todos created after
      // the v11 migration (which only back-fills pre-existing todos).
      docs.ensureDefaultDocs(req.todoId);
      return Promise.resolve(okResult(docs.list(req.todoId)));
    } catch (err) {
      return Promise.resolve(failResult('document_list_failed', (err as Error).message));
    }
  });

  register('document.create', (_e, req) => {
    try {
      const doc = docs.create(req.todoId, req.kind, req.title ?? null, {
        refId: req.refId,
        url: req.url,
        description: req.description,
      });
      broadcastDataChanged('content');
      return Promise.resolve(okResult(doc));
    } catch (err) {
      return Promise.resolve(failResult('document_create_failed', (err as Error).message));
    }
  });

  register('document.read', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.read(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('document_read_failed', (err as Error).message));
    }
  });

  register('document.write', (_e, req) => {
    try {
      const res = docs.write(req.id, req.content, req.expectVersion);
      // Mirror to disk for git-history + file explorer. Only progress +
      // note_md carry versioned text; other kinds have no file backing.
      const doc = docs.get(req.id);
      if (doc && (doc.kind === 'progress' || doc.kind === 'note_md')) {
        docs.writeToFile(
          resolveTaskDir(doc.todoId),
          doc.kind,
          doc.title ?? '',
          req.content,
        );
        // Commit to git so the per-document History popover has something
        // to show. Best-effort: a failed commit must NOT surface as a write
        // failure (the body is already on disk + in the DB).
        void commitDocToGit(doc, res.version);
      }
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
      const before = docs.get(req.id);
      docs.rename(req.id, req.title);
      const after = docs.get(req.id)!;
      // Rename the on-disk file for note_md docs (progress.md never moves).
      if (before && (before.kind === 'progress' || before.kind === 'note_md')) {
        docs.renameFile(
          resolveTaskDir(after.todoId),
          before.kind,
          before.title ?? '',
          req.title,
        );
      }
      return Promise.resolve(okResult(after));
    } catch (err) {
      return Promise.resolve(failResult('document_rename_failed', (err as Error).message));
    }
  });

  register('document.remove', (_e, req) => {
    try {
      const before = docs.get(req.id);
      docs.remove(req.id);
      if (before && (before.kind === 'progress' || before.kind === 'note_md')) {
        docs.removeFile(
          resolveTaskDir(before.todoId),
          before.kind,
          before.title ?? '',
        );
      }
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('document_remove_failed', (err as Error).message));
    }
  });

  register('document.history', (_e, req) => {
    try {
      return Promise.resolve(okResult(docs.history(req.id)));
    } catch (err) {
      return Promise.resolve(failResult('document_history_failed', (err as Error).message));
    }
  });

  register('document.restoreVersion', async (_e, req) => {
    try {
      const before = docs.get(req.id);
      docs.restoreVersion(req.id, req.versionId);
      // Re-mirror to disk so git-history reflects the restored content, and
      // commit it as a new save so the History popover shows the restore.
      if (before && (before.kind === 'progress' || before.kind === 'note_md')) {
        const current = docs.read(req.id);
        docs.writeToFile(
          resolveTaskDir(before.todoId),
          before.kind,
          before.title ?? '',
          current.content,
        );
        void commitDocToGit(before, current.version);
      }
      broadcastDataChanged('content');
      return Promise.resolve(okResult(undefined as never));
    } catch (err) {
      return Promise.resolve(failResult('document_restore_failed', (err as Error).message));
    }
  });

  register('document.gitHistory', async (_e, req) => {
    try {
      const doc = docs.get(req.id);
      if (!doc) return failResult('document_not_found', `document ${req.id} not found`);
      const available = await gitHistory.gitAvailable();
      if (!available) return okResult({ available: false, entries: [] });
      const entries = (await gitHistory.getFileLog(todosDir, docRelPath(doc))) ?? [];
      return okResult({ available: true, entries });
    } catch (err) {
      return failResult('git_history_failed', (err as Error).message);
    }
  });

  register('document.gitRestore', async (_e, req) => {
    try {
      const doc = docs.get(req.id);
      if (!doc) return failResult('document_not_found', `document ${req.id} not found`);
      if (doc.kind !== 'progress' && doc.kind !== 'note_md') {
        return failResult('git_restore_failed', `document kind ${doc.kind} has no file backing`);
      }
      const content = await gitHistory.getFileAtSha(todosDir, docRelPath(doc), req.sha);
      if (content == null) return failResult('git_restore_failed', `no content at ${req.sha}`);
      // Write the restored content back as a new DB version (mirrors to disk +
      // keeps FTS index in sync), then commit so the restore itself is logged.
      const res = docs.write(req.id, content);
      void commitDocToGit(doc, res.version);
      broadcastDataChanged('content');
      return okResult(undefined as never);
    } catch (err) {
      return failResult('git_restore_failed', (err as Error).message);
    }
  });

  logger.info('document.* handlers registered');
}
