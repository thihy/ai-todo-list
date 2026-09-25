// memo 整理动作的 IPC handler 测试（schema v21）。
//
// 覆盖三条整理路径 + 两条快路径的不变量：
//   1. 并入已有任务 → 正文追加进 progress 文档（带分隔线），附件复制过去，
//      memo 及其目录一起消失，todos.body / FTS5 同步更新
//   2. 变成新任务 → 标题缺省用 preview，progress 文档 = memo 原文，附件转过去
//   3. 标记为纯记录 → 留在备忘录但默认列表不再返回，可撤销
//   4. memo.ingest 带 targetTodoId → 一次往返完成落盘+并入，不留残渣
//   5. 目标任务不存在 → failResult('todo_not_found')，memo 完整保留可重试
//   6. 附件转移用 copy 不是 move：合并后任务的附件文件在，memo 目录已删

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sentPayloads: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => {
  class FakeWebContents {
    send = (channel: string, payload: unknown): void => {
      sentPayloads.push({ channel, payload });
    };
  }
  // One live window, so broadcastDataChanged() actually has somewhere to
  // send — an empty window list would silently pass the broadcast assertion.
  const fakeWindows: Array<{ webContents: FakeWebContents; destroyed: boolean }> = [
    { webContents: new FakeWebContents(), destroyed: false },
  ];
  return {
    BrowserWindow: {
      getAllWindows: () =>
        fakeWindows.map((w) => ({
          isDestroyed: () => w.destroyed,
          webContents: w.webContents,
        })),
    },
  };
});

vi.mock('../../src/main/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setThreshold: vi.fn(),
  },
}));

import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { DocumentStore } from '../../src/main/files/documents';
import { InboxStore } from '../../src/main/files/inbox';
import { MemoStore } from '../../src/main/files/memos';
import { TaskDirectoryStore } from '../../src/main/files/task-directories';
import {
  handleMemoCreate,
  handleMemoIngest,
  handleMemoList,
  handleMemoMerge,
  handleMemoPromote,
  handleMemoResolve,
  type MemoHandlerDeps,
} from '../../src/main/ipc/memo-handlers';
import type { Memo, Todo } from '../../src/shared/todo-types';

describe('memo organize handlers', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let docs: DocumentStore;
  let inbox: InboxStore;
  let memos: MemoStore;
  let memosDir: string;
  let deps: MemoHandlerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memo-handlers-'));
    handle = openDb(join(dir, 'db.sqlite'));
    const todosDir = join(dir, 'todos');
    const attachmentsDir = join(dir, 'inbox-attachments');
    memosDir = join(dir, 'memos');
    repo = new TodoRepo(handle.db);
    const taskDirs = new TaskDirectoryStore(handle.db, todosDir);
    const resolveTaskDir = (id: string): string => taskDirs.resolve(id);
    docs = new DocumentStore(handle.db);
    inbox = new InboxStore(handle.db, attachmentsDir, todosDir, resolveTaskDir);
    memos = new MemoStore(handle.db, memosDir);
    deps = { memos, docs, todos: repo, inbox, resolveTaskDir };
    sentPayloads.length = 0;
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Read a task's progress document body. */
  function progressBody(todoId: string): string {
    docs.ensureDefaultDocs(todoId);
    const doc = docs.list(todoId).find((d) => d.kind === 'progress');
    expect(doc).toBeDefined();
    return docs.read(doc!.id).content;
  }

  describe('① 并入已有任务 (memo.mergeIntoTask)', () => {
    it('appends the memo body into the target progress doc and deletes the memo', () => {
      const todo = repo.create({ title: '登录页改版' });
      docs.ensureDefaultDocs(todo.id);
      const doc = docs.list(todo.id).find((d) => d.kind === 'progress')!;
      docs.write(doc.id, '第一版做完了');

      const created = handleMemoCreate(deps, { content: '客户说按钮要更醒目' });
      expect(created.ok).toBe(true);
      const memo = (created as { data: Memo }).data;

      const res = handleMemoMerge(deps, { id: memo.id, todoId: todo.id });
      expect(res.ok).toBe(true);
      expect(res).toMatchObject({ ok: true, data: { todoId: todo.id } });

      const body = progressBody(todo.id);
      expect(body).toContain('第一版做完了');
      expect(body).toContain('客户说按钮要更醒目');
      // A dated divider keeps repeated merges readable as a timeline.
      expect(body).toContain('## 整理自备忘录');
      // The memo itself is gone — row + projection directory.
      expect(memos.get(memo.id)).toBeNull();
    });

    it('keeps todos.body in sync so FTS5 search sees the merged text', () => {
      const todo = repo.create({ title: '登录页改版' });
      // Search the whole merged phrase, not a fragment. FTS5 `unicode61`
      // treats a run of CJK as ONE token, and repo.search appends a `*`
      // prefix operator — so `按钮*` can only match a token *starting*
      // with 按钮, never one containing it mid-run. That's a pre-existing
      // property of the index (same for any task body), not something the
      // merge path introduces; what this test pins is that the merged
      // text reaches todos.body and the FTS index at all.
      const phrase = '客户说按钮要更醒目';
      expect(repo.search(phrase).map((h) => h.todo.id)).not.toContain(todo.id);

      const created = handleMemoCreate(deps, { content: phrase });
      const memo = (created as { data: Memo }).data;
      handleMemoMerge(deps, { id: memo.id, todoId: todo.id });

      // DocumentStore.write mirrors the progress body onto todos.body — the
      // external-content FTS table reads it. If that mirror were bypassed the
      // merged text would be invisible to search, so this pins the whole
      // write path (progress doc → todos.body → FTS trigger).
      const hits = repo.search(phrase);
      expect(hits.map((h) => h.todo.id)).toContain(todo.id);
      // The snippet is read from the body column, so seeing the merged text
      // there also proves the FTS index carries it.
      expect(hits[0].snippet).toContain('按钮');
    });

    it('copies attachments to the task and removes the memo directory', () => {
      const todo = repo.create({ title: '带图任务' });
      const src = join(dir, 'sketch.png');
      writeFileSync(src, Buffer.from('fake-png-bytes'));

      const created = handleMemoCreate(deps, {
        content: '这是新草图',
        files: [{ name: 'sketch.png', path: src }],
      });
      const memo = (created as { data: Memo }).data;
      expect(memo.attachmentIds).toHaveLength(1);
      const memoDir = join(memosDir, `${memo.id.slice(0, 6)}-这是新草图`);
      expect(existsSync(memoDir)).toBe(true);

      handleMemoMerge(deps, { id: memo.id, todoId: todo.id });

      // Attachment landed on the task and its bytes are readable.
      const moved = inbox.list(todo.id);
      expect(moved).toHaveLength(1);
      expect(moved[0].filePath).toContain('sketch.png');
      expect(existsSync(moved[0].filePath)).toBe(true);
      // The memo's own directory is cleaned up.
      expect(existsSync(memoDir)).toBe(false);
    });

    it('fails with todo_not_found and leaves the memo intact for retry', () => {
      const created = handleMemoCreate(deps, { content: '这段还没想好' });
      const memo = (created as { data: Memo }).data;

      // Never invent a task id — a missing target is an error, not a
      // silent create (AGENTS.md invariant #10).
      const res = handleMemoMerge(deps, { id: memo.id, todoId: '01NOSUCHTASK' });
      expect(res.ok).toBe(false);
      expect((res as { code: string }).code).toBe('todo_not_found');
      expect(memos.get(memo.id)).not.toBeNull();
    });

    it('fails with memo_not_found for an unknown memo id', () => {
      const todo = repo.create({ title: '随便什么' });
      const res = handleMemoMerge(deps, { id: '01NOPEMEMO', todoId: todo.id });
      expect(res.ok).toBe(false);
      expect((res as { code: string }).code).toBe('memo_not_found');
    });
  });

  describe('② 变成新任务 (memo.promoteToTask)', () => {
    it('creates a task titled by the memo preview with the body as its progress', () => {
      const created = handleMemoCreate(deps, {
        content: '给周报加一个数据看板\n\n先出三张图对比',
      });
      const memo = (created as { data: Memo }).data;

      const res = handleMemoPromote(deps, { id: memo.id });
      expect(res.ok).toBe(true);
      const todoId = (res as { data: { todoId: string } }).data.todoId;

      const todo = repo.get(todoId) as Todo;
      expect(todo.title).toBe('给周报加一个数据看板');
      // The whole memo body becomes the new task's progress — no divider
      // prefix, since at this point it IS the content.
      const body = progressBody(todoId);
      expect(body).toContain('给周报加一个数据看板');
      expect(body).toContain('先出三张图对比');
      expect(body).not.toContain('整理自备忘录');
      expect(memos.get(memo.id)).toBeNull();
    });

    it('honours an explicit title over the preview', () => {
      const created = handleMemoCreate(deps, { content: '随手记一句' });
      const memo = (created as { data: Memo }).data;
      const res = handleMemoPromote(deps, { id: memo.id, title: '正经标题' });
      const todoId = (res as { data: { todoId: string } }).data.todoId;
      expect(repo.get(todoId)?.title).toBe('正经标题');
    });

    it('falls back to 未命名片段 when the memo has no text', () => {
      const src = join(dir, 'only-image.png');
      writeFileSync(src, Buffer.from('bytes'));
      const created = handleMemoCreate(deps, {
        content: '',
        files: [{ name: 'only-image.png', path: src }],
      });
      const memo = (created as { data: Memo }).data;
      const res = handleMemoPromote(deps, { id: memo.id });
      const todoId = (res as { data: { todoId: string } }).data.todoId;
      expect(repo.get(todoId)?.title).toBe('未命名片段');
      expect(inbox.list(todoId)).toHaveLength(1);
    });

    it('transfers attachments onto the new task', () => {
      const src = join(dir, 'ref.png');
      writeFileSync(src, Buffer.from('reference-bytes'));
      const created = handleMemoCreate(deps, {
        content: '参考图',
        files: [{ name: 'ref.png', path: src }],
      });
      const memo = (created as { data: Memo }).data;
      const res = handleMemoPromote(deps, { id: memo.id });
      const todoId = (res as { data: { todoId: string } }).data.todoId;
      const moved = inbox.list(todoId);
      expect(moved).toHaveLength(1);
      expect(existsSync(moved[0].filePath)).toBe(true);
    });
  });

  describe('③ 标记为纯记录 (memo.markResolved)', () => {
    it('keeps the memo but drops it from the default list, and can be undone', () => {
      const created = handleMemoCreate(deps, { content: '今天天气不错' });
      const memo = (created as { data: Memo }).data;

      const res = handleMemoResolve(deps, { id: memo.id, resolved: true });
      expect(res.ok).toBe(true);
      expect((res as { data: Memo }).data.resolvedAt).not.toBeNull();

      // Still on disk, just no longer in the 待整理 list.
      expect(memos.get(memo.id)).not.toBeNull();
      const pending = handleMemoList(deps, {});
      expect((pending as { data: Memo[] }).data.map((m) => m.id)).not.toContain(memo.id);
      const all = handleMemoList(deps, { includeResolved: true });
      expect((all as { data: Memo[] }).data.map((m) => m.id)).toContain(memo.id);

      // Undo puts it back in the pending list.
      handleMemoResolve(deps, { id: memo.id, resolved: false });
      const back = handleMemoList(deps, {});
      expect((back as { data: Memo[] }).data.map((m) => m.id)).toContain(memo.id);
    });

    it('returns null (not a throw) for an unknown id', () => {
      const res = handleMemoResolve(deps, { id: '01NOPE', resolved: true });
      expect(res).toEqual({ ok: true, data: null });
    });
  });

  describe('memo.ingest 快路径', () => {
    it('lands a memo when no target task is given', () => {
      const res = handleMemoIngest(deps, { content: '随便一段' });
      expect(res).toEqual({ ok: true, data: { todoId: null, memoId: expect.any(String) } });
      const memoId = (res as { data: { memoId: string } }).data.memoId;
      expect(memos.get(memoId)?.content).toBe('随便一段');
    });

    it('merges straight into the target task in one round trip, leaving no memo behind', () => {
      const todo = repo.create({ title: '拖拽目标' });
      docs.ensureDefaultDocs(todo.id);
      const doc = docs.list(todo.id).find((d) => d.kind === 'progress')!;
      docs.write(doc.id, '原有内容');

      const res = handleMemoIngest(deps, { content: '拖过来的补充', targetTodoId: todo.id });
      expect(res).toEqual({ ok: true, data: { todoId: todo.id, memoId: null } });
      expect(progressBody(todo.id)).toContain('拖过来的补充');
      // The intermediate memo must not survive the fast path.
      expect(memos.list(true)).toHaveLength(0);
    });

    it('carries attachments through the fast path', () => {
      const todo = repo.create({ title: '拖拽目标' });
      const src = join(dir, 'drop.png');
      writeFileSync(src, Buffer.from('dropped'));

      const res = handleMemoIngest(deps, {
        content: '看这个',
        targetTodoId: todo.id,
        files: [{ name: 'drop.png', path: src }],
      });
      expect(res.ok).toBe(true);
      expect(inbox.list(todo.id)).toHaveLength(1);
    });

    it('rejects an empty drop', () => {
      const res = handleMemoIngest(deps, { content: '' });
      expect(res.ok).toBe(false);
      expect((res as { code: string }).code).toBe('empty');
    });

    it('rejects more than 10 files', () => {
      const files = Array.from({ length: 11 }, (_, i) => ({
        name: `f${i}.txt`,
        path: join(dir, `f${i}.txt`),
      }));
      const res = handleMemoIngest(deps, { content: 'x', files });
      expect(res.ok).toBe(false);
      expect((res as { code: string }).code).toBe('too_many_files');
    });
  });

  it('broadcasts a memos-scope data-changed after every mutation', () => {
    const created = handleMemoCreate(deps, { content: '广播测试' });
    const memo = (created as { data: Memo }).data;
    handleMemoResolve(deps, { id: memo.id, resolved: true });
    const scopes = sentPayloads
      .filter((p) => p.channel === 'app:data-changed')
      .map((p) => (p.payload as { scope: string }).scope);
    expect(scopes).toContain('memos');
    expect(scopes.length).toBeGreaterThanOrEqual(2);
  });
});
