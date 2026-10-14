// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { InboxStore } from '../../src/main/files/inbox';
import { TaskDirectoryStore } from '../../src/main/files/task-directories';
import * as gitHistory from '../../src/main/git-history';

// Execute the production callback with real SQLite/files/Git, without booting
// Electron's main entry point. No duplicate deletion implementation in tests.
function productionHandler(inbox: InboxStore, todosDir: string, broadcastDataChanged: ReturnType<typeof vi.fn>, history = gitHistory) {
  const filename = resolve('src/main/index.ts');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'register' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'inbox.remove') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error('Production inbox.remove handler missing');
  const script = ts.transpileModule(`const handler = ${callback.getText(source)}; handler;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(script, {
    inbox, todosDir, basename, gitHistory: history, broadcastDataChanged,
    okResult: (data: unknown) => ({ ok: true, data }),
    failResult: (code: string, message: string) => ({ ok: false, code, message }),
  }) as (_event: unknown, req: { id: string }) => Promise<{ ok: boolean }>;
}

describe('inbox.remove Git history', () => {
  let root: string;
  let todosDir: string;
  let db: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let inbox: InboxStore;
  let broadcast: ReturnType<typeof vi.fn>;
  const git = (args: string[]): string => execFileSync('git', args, { cwd: todosDir, encoding: 'utf8', windowsHide: true });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'inbox-remove-git-'));
    todosDir = join(root, 'todos');
    db = openDb(join(root, 'todos.db'));
    repo = new TodoRepo(db.db);
    const directories = new TaskDirectoryStore(db.db, todosDir);
    inbox = new InboxStore(db.db, join(root, 'legacy-attachments'), todosDir, (id) => directories.resolve(id));
    broadcast = vi.fn();
    await gitHistory.ensureGitRepo(todosDir);
  });
  afterEach(() => {
    db.close();
    // root is the exact newly created test directory, never user task data.
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  async function trackedAttachment() {
    const task = repo.create({ title: '删除附件测试' }, 'test');
    const attachment = inbox.attachBlob(task.id, 'data:image/png;base64,cGl4ZWw=', '截图 图片', 'image/png');
    expect(await gitHistory.commitAll(todosDir, '新增测试附件')).toBeTruthy();
    return attachment;
  }

  it('commits the deletion before the IPC response and leaves the Git worktree clean', async () => {
    const attachment = await trackedAttachment();
    const previous = git(['rev-parse', 'HEAD']).trim();
    const result = await productionHandler(inbox, todosDir, broadcast)(undefined, { id: attachment.id });
    expect(result.ok).toBe(true);
    expect(inbox.get(attachment.id)).toBeNull();
    expect(existsSync(attachment.filePath)).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).not.toBe(previous);
    expect(git(['log', '-1', '--format=%s']).trim()).toBe(`删除附件 ${basename(attachment.filePath)}`);
    const relPath = relative(todosDir, attachment.filePath).split(sep).join('/');
    expect(git(['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', 'HEAD', '--', relPath])).toBe(`D\0${relPath}\0`);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(broadcast).toHaveBeenCalledWith('content');
  });

  it('records a tracked deletion even when the attachment file was already missing', async () => {
    const attachment = await trackedAttachment();
    unlinkSync(attachment.filePath);
    expect((await productionHandler(inbox, todosDir, broadcast)(undefined, { id: attachment.id })).ok).toBe(true);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(inbox.get(attachment.id)).toBeNull();
  });

  it('does not commit unrelated work when a missing attachment is deleted again', async () => {
    const attachment = await trackedAttachment();
    const handler = productionHandler(inbox, todosDir, broadcast);
    await handler(undefined, { id: attachment.id });
    const previous = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(todosDir, 'unrelated.md'), 'pending user edit');
    expect((await handler(undefined, { id: attachment.id })).ok).toBe(true);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(previous);
    expect(git(['status', '--porcelain'])).toContain('unrelated.md');
  });

  it('still deletes successfully if Git is unavailable or its commit fails', async () => {
    const attachment = await trackedAttachment();
    const history = { ...gitHistory, commitAll: vi.fn().mockRejectedValue(new Error('git unavailable')) };
    expect((await productionHandler(inbox, todosDir, broadcast, history)(undefined, { id: attachment.id })).ok).toBe(true);
    expect(inbox.get(attachment.id)).toBeNull();
    expect(existsSync(attachment.filePath)).toBe(false);
    expect(broadcast).toHaveBeenCalledWith('content');
  });
});
