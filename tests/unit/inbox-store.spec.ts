// InboxStore tests: attach / attachBlob / list / read (→ dataUrl) / remove /
// rename (companion task_documents.title + inline image alt sweep).
// Locks the contract that the renderer never sees an absolute path — only a
// data: URL — and that attachments are keyed by todoId.
//
// Per-task layout (post-refactor): files live under
// {todosDir}/{slug}/attachments/. We pre-compute the taskDir via
// paths.uniqueTodoDir (no mkdir) so test assertions and store calls share
// the same path string.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// electron 在 vitest 里没真实实例；mock 掉 app.getPath 防止 logger.ts 在
// import 时炸（baseline 上 inbox-store 等直接 import main logger 的 spec
// 都因这个 fail，与本次改动无关 —— 这里只是为了让我们新增的 rename 测试
// 能跑起来）。
vi.mock('electron', () => ({
  app: { getPath: () => '.' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { InboxStore } from '../../src/main/files/inbox';
import * as paths from '../../src/main/files/paths';

describe('InboxStore per-task layout', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let inbox: InboxStore;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-inbox-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
    inbox = new InboxStore(
      handle.db,
      join(dir, 'attachments'),
      todosDir,
      (id) => {
        const t = repo.get(id);
        return paths.todoDir(todosDir, (t?.title as string | undefined) ?? paths.UNTITLED_SLUG, id);
      },
    );
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attach copies a file into {taskDir}/attachments/ and list returns it keyed by todoId', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const src = join(dir, 'note.txt');
    writeFileSync(src, 'hello attachments', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    expect(att.todoId).toBe(t.id);
    expect(att.mime).toBe('text/plain');
    // file lands inside per-task attachments dir
    expect(att.filePath).toContain('attachments');
    expect(att.filePath.startsWith(taskDir)).toBe(true);
    expect(existsSync(att.filePath)).toBe(true);
    const list = inbox.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(att.id);
  });

  it('attachBlob decodes a base64 data URL into {taskDir}/attachments/', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const b64 = Buffer.from('pixel-data').toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;
    const att = inbox.attachBlob(t.id, dataUrl, 'shot.png', 'image/png');
    expect(att.filePath.startsWith(taskDir)).toBe(true);
    expect(existsSync(att.filePath)).toBe(true);
    const read = inbox.read(att.id);
    expect(read.dataUrl).toBe(dataUrl);
    expect(read.mime).toBe('image/png');
    // attachBlob always appends the mime extension (pre-existing behavior),
    // so 'shot.png' → 'shot.png.png' on disk; read() recovers that basename.
    expect(read.filename).toBe('shot.png.png');
    expect(read.dataUrl).not.toContain(dir); // no absolute path leaks
  });

  it('todo.attachmentIds is populated from inbox_attachments (no longer [])', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'a', 'utf8');
    inbox.attach(t.id, src, 'text/plain');
    const fetched = repo.get(t.id);
    expect(fetched!.attachmentIds).toHaveLength(1);
  });

  it('remove deletes the file and the row', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'a', 'utf8');
    const att = inbox.attach(t.id, src, 'text/plain');
    const path = att.filePath;
    expect(existsSync(path)).toBe(true);
    inbox.remove(att.id);
    expect(inbox.list(t.id)).toHaveLength(0);
    expect(inbox.get(att.id)).toBeNull();
    expect(() => inbox.read(att.id)).toThrow(/attachment_not_found/);
    // The attachments dir may still exist (empty) but the file is gone.
    expect(existsSync(path)).toBe(false);
    expect(taskDir).toBeTruthy();
  });

  it('read throws on unknown id', () => {
    expect(() => {
      inbox.read('nope');
    }).toThrow(/attachment_not_found/);
  });

  // --- rename: 改附件名 → 改 task_documents.title + 扫所有 progress/note_md
  // 文档替换 ![old](attachment://<id>) 的 alt 文本 ---

  /** Helper: 在数据库里直接塞一个 progress doc + 一条 content version。 */
  function seedProgressDoc(todoId: string, docId: string, content: string): void {
    const now = Date.now();
    handle.db
      .prepare(
        `INSERT INTO task_documents (id, todo_id, kind, title, ref_id, created_at, updated_at)
         VALUES (?, ?, 'progress', '进展', NULL, ?, ?)`,
      )
      .run(docId, todoId, now, now);
    handle.db
      .prepare(
        `INSERT INTO document_versions (document_id, content, saved_at) VALUES (?, ?, ?)`,
      )
      .run(docId, content, now);
  }

  it('rename：磁盘文件 {ulid}-{old}.{ext} 改名为 {ulid}-{new}.{ext}，inbox_attachments.file_path 跟上', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'pic.png');
    writeFileSync(src, 'pixel', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    const oldPath = att.filePath;
    // attach() 透传 basename —— 文件名就是 pic.png，不会像 attachBlob 那样
    // 再补一个 mime ext。rename 应该原地改成 screenshot-20260101.png。
    expect(oldPath.endsWith('-pic.png')).toBe(true);

    inbox.rename(att.id, 'screenshot-20260101', () => undefined);

    const reloaded = inbox.get(att.id)!;
    expect(reloaded.filePath).not.toBe(oldPath);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(reloaded.filePath)).toBe(true);
    expect(reloaded.filePath.endsWith('-screenshot-20260101.png')).toBe(true);
    // ulid 前缀保持 —— InboxStore.read 还要靠它定位文件。
    expect(reloaded.filePath).toContain(att.id);
  });

  it('rename：同步更新 companion task_documents.title（kind=attachment, ref_id=id）', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'a.png');
    writeFileSync(src, 'p', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    // companion doc —— 与 TodoEditorPane pickFiles 路径一致。
    handle.db
      .prepare(
        `INSERT INTO task_documents (id, todo_id, kind, title, ref_id, created_at, updated_at)
         VALUES (?, ?, 'attachment', 'pasted-20260101-120000-1', ?, ?, ?)`,
      )
      .run('attdoc-1', t.id, att.id, Date.now(), Date.now());

    inbox.rename(att.id, '截图-设计稿', () => undefined);

    const row = handle.db
      .prepare<[string], { title: string | null }>(
        `SELECT title FROM task_documents WHERE id = ?`,
      )
      .get('attdoc-1');
    expect(row?.title).toBe('截图-设计稿');
  });

  it('rename：扫到 progress/note_md 文档的 ![old](attachment://<id>) → callback 拿到新 alt 的版本', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'p.png');
    writeFileSync(src, 'p', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    const docId = `${t.id}:progress`;
    const before = `# 进展\n\n` +
      `![pasted-20260101-120000-1](attachment://${att.id})\n` +
      `\n看看这段截图：\n` +
      `![pasted-20260101-120000-1](attachment://${att.id})\n`;
    seedProgressDoc(t.id, docId, before);

    const rewrites: Array<{ id: string; content: string }> = [];
    inbox.rename(att.id, 'login-page-design', (id, content) => {
      rewrites.push({ id, content });
    });

    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.id).toBe(docId);
    // 两处 alt 都换成新名，attachment id 保持不变
    const after = rewrites[0]!.content;
    expect(after).toContain(`![login-page-design](attachment://${att.id})`);
    expect(after).not.toContain('pasted-20260101-120000-1');
    // 其它正文不变
    expect(after).toContain('看看这段截图');
    expect(after).toContain('# 进展');
  });

  it('rename：新名字包含 markdown 元字符 [ / ( 时仍安全（占位两段替换避免二次破坏）', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'p.png');
    writeFileSync(src, 'p', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    const docId = `${t.id}:progress`;
    const before = `before ![p](attachment://${att.id}) after`;
    seedProgressDoc(t.id, docId, before);

    // 新名字含 ] 和 ) —— naive 的「oldAlt → newTitle」会把 markdown 链接语法碰坏。
    // 占位两段替换保证「先标占位、再统一换回」一定走完整遍。
    const captured: string[] = [];
    inbox.rename(att.id, 'has]bracket(and)paren', (id, content) => {
      captured.push(content);
    });

    expect(captured).toHaveLength(1);
    const after = captured[0]!;
    expect(after).toContain(`![has]bracket(and)paren](attachment://${att.id})`);
    expect(after).not.toContain('![p](');
  });

  it('rename：不存在的 id 抛 attachment_not_found', () => {
    expect(() => inbox.rename('does-not-exist', 'x', () => undefined))
      .toThrow(/attachment_not_found/);
  });

  it('rename：空字符串抛 attachment_name_empty', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'p.png');
    writeFileSync(src, 'p', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    expect(() => inbox.rename(att.id, '   ', () => undefined))
      .toThrow(/attachment_name_empty/);
  });

  it('rename：没进任何 progress / note_md 文档时 callback 不被调用', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const src = join(dir, 'p.png');
    writeFileSync(src, 'p', 'utf8');
    const att = inbox.attach(t.id, src, 'image/png');
    let calls = 0;
    inbox.rename(att.id, 'renamed', () => {
      calls++;
    });
    expect(calls).toBe(0);
    // 磁盘文件 + task_documents.title 还是要更新（如果存在 companion row）
    expect(inbox.get(att.id)!.filePath).toContain('-renamed.');
  });
});
