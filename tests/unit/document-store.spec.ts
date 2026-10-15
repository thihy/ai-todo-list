// DocumentStore tests —— 文件即文档（schema v21）。
//
// task_documents 表没了：一个任务有哪些文档、叫什么名字，全部由任务目录的
// 文件列表决定（TaskFileIndex 扫盘 + 缓存），DB 只剩 document_versions
// （文本版本历史，按 (todoId, fileName) 索引）。链接另有 todo_links。
//
// 下面这些用例锁住四条不变量：
//   1. 文件名 == 标签，除了 progress.md（标签固定「进展」，不重命名不递增）。
//   2. 绝不覆盖：撞名递增成 文档_1 / 文档_2，分配到的名字同时就是新标签。
//   3. 先写文件：create 建文件、remove 删文件、rename 搬文件。
//   4. 列表来自目录扫描，带缓存；refreshFiles() 清缓存后重读。
//
// TaskDir 取法沿用 drawing-store.spec.ts：store 方法现在直接收 taskDir（不再
// 自己按 todoId 解析），所以断言侧用 paths.uniqueTodoDir()（纯字符串，不建
// 目录）算出同一个路径即可。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { MarkdownStore } from '../../src/main/files/markdown';
import { DocumentStore, LinkStore } from '../../src/main/files/documents';
import { TaskFileIndex } from '../../src/main/files/task-files';
import * as paths from '../../src/main/files/paths';

describe('DocumentStore 文件即文档（schema v21）', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let md: MarkdownStore;
  let docs: DocumentStore;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
    // MarkdownStore 只在「桥接旧正文」那条用例里出现：它模拟 v21 之前遗留的
    // content_versions 写法。resolver 不建目录，writeBody 自己会 mkdir。
    md = new MarkdownStore(handle.db, todosDir, (id) => {
      const t = repo.get(id);
      return paths.uniqueTodoDir(
        todosDir,
        paths.slugify((t?.title as string | undefined) ?? paths.UNTITLED_SLUG),
        id,
      );
    });
    docs = new DocumentStore(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 一个任务 + 它（尚未创建）的任务目录路径。 */
  const newTask = (title: string): { id: string; taskDir: string } => {
    const t = repo.create({ title }, 'x');
    return { id: t.id, taskDir: paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id) };
  };

  const names = (taskDir: string): string[] =>
    docs.listFiles(taskDir).map((f) => f.fileName);

  it('ensureDefaultDocs 建出 progress.md，标签固定「进展」', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    const list = docs.listFiles(taskDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('progress');
    expect(list[0]!.fileName).toBe('progress.md');
    expect(list[0]!.label).toBe('进展');
    expect(existsSync(paths.progressFile(taskDir))).toBe(true);
    // 旧用例断言的是 list() 的 ord === 0；新模型里 entry 没有 ord 字段，
    // 「进展排第一」改由 listFiles 的排序保证 —— 所以断言它就是第 0 项。
    expect(list[0]!.fileName).toBe('progress.md');
  });

  it('进展文件丢失时从已保存的版本恢复，不写成空文件', () => {
    const { id, taskDir } = newTask('恢复进展');
    docs.ensureDefaultDocs(id, taskDir);
    docs.saveContent(taskDir, id, 'progress.md', '已有进展内容');
    unlinkSync(join(taskDir, 'progress.md'));
    docs.ensureDefaultDocs(id, taskDir);
    expect(readFileSync(join(taskDir, 'progress.md'), 'utf8')).toBe('已有进展内容');
    expect(docs.history(id, 'progress.md')).toHaveLength(1);
  });

  it('旧正文(content_versions)桥接进展文档，版本历史完整保留', () => {
    // 一个 v21 之后才建的 todo，正文仍可能走老路写进 content_versions。
    // ensureDefaultDocs 必须把它桥接进展文档，正文与历史都不能丢。
    const { id, taskDir } = newTask('Has Notes');
    md.writeBody(id, '# v1\nfirst');
    md.writeBody(id, '# v2\nsecond');

    docs.ensureDefaultDocs(id, taskDir);
    // 旧用例是 docs.list(t.id).find(kind==='progress') 再 docs.read(doc.id)；
    // 现在文档身份就是文件名，直接按 'progress.md' 读。
    const read = docs.read(id, 'progress.md');
    expect(read.content).toBe('# v2\nsecond');
    expect(docs.history(id, 'progress.md')).toHaveLength(2);
    // 桥接之后磁盘上的 progress.md 也要跟上（git / 文件管理器看的是文件）。
    expect(readFileSync(paths.progressFile(taskDir), 'utf8')).toBe('# v2\nsecond');
  });

  it('吸收迁移遗留的 笔记.md，用户自己建的文档不受影响', () => {
    // v11 迁移给旧任务建过一个标签「笔记」的 note_md。ensureDefaultDocs 要把
    // 它的内容折进进展文档，再删掉那个文件 —— 磁盘上只剩一个进展文档。
    const { id, taskDir } = newTask('T');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, '笔记.md'), '笔记内容', 'utf8');
    docs.write(id, '笔记.md', '笔记内容');

    docs.ensureDefaultDocs(id, taskDir);
    expect(names(taskDir)).toEqual(['progress.md']);
    expect(docs.listFiles(taskDir)[0]!.kind).toBe('progress');
    expect(docs.read(id, 'progress.md').content).toBe('笔记内容');
    // 旧用例断言的是 task_documents 那行没了；新模型没有行，只有文件 ——
    // 等价保证是「那个文件被删掉」。
    expect(existsSync(join(taskDir, '笔记.md'))).toBe(false);
  });

  it('用户通过「+」建的 文档 survive 再次 ensureDefaultDocs，且内容不被抹掉', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    const doc = docs.createNoteFile(taskDir);
    expect(doc.fileName).toBe('文档.md');
    docs.saveContent(taskDir, id, doc.fileName, 'hello');

    docs.ensureDefaultDocs(id, taskDir);
    const list = docs.listFiles(taskDir);
    expect(list).toHaveLength(2);
    expect(list.find((f) => f.label === '文档')).toBeTruthy();
    expect(readFileSync(join(taskDir, '文档.md'), 'utf8')).toBe('hello');
  });

  it('write 追加版本并裁剪到 MAX_BODY_VERSIONS', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    for (let i = 0; i < 25; i++) docs.write(id, 'progress.md', `v${i}`);
    // MAX_BODY_VERSIONS = 20
    expect(docs.history(id, 'progress.md').length).toBeLessThanOrEqual(20);
    // 最新内容是最后一次写入
    expect(docs.read(id, 'progress.md').content).toBe('v24');
  });

  it('restoreVersion 回滚到历史版本；版本号不存在时抛 version_not_found', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    const v1 = docs.write(id, 'progress.md', 'v1').version;
    docs.write(id, 'progress.md', 'v2');
    docs.restoreVersion(id, 'progress.md', v1);
    expect(docs.read(id, 'progress.md').content).toBe('v1');
    expect(() => docs.restoreVersion(id, 'progress.md', 999_999)).toThrow(
      /version_not_found/,
    );
  });

  it('版本冲突检测：expectVersion 过期时抛 version_conflict', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    const v0 = docs.read(id, 'progress.md').version; // 0（从未写过）
    docs.write(id, 'progress.md', 'a', v0);
    expect(() => docs.write(id, 'progress.md', 'b', v0)).toThrow(/version_conflict/);
  });

  // --- 不变量 2：绝不覆盖 -------------------------------------------------

  it('同名文档不互相覆盖：第二个拿到 文档_1，两个文件各自留着内容', () => {
    const { id, taskDir } = newTask('T');
    const first = docs.createNoteFile(taskDir);
    const second = docs.createNoteFile(taskDir);
    // 分配到的名字同时就是标签 —— 用户看到的是「第 2 个同名文档」。
    expect(first.fileName).toBe('文档.md');
    expect(first.label).toBe('文档');
    expect(second.fileName).toBe('文档_1.md');
    expect(second.label).toBe('文档_1');
    expect(first.kind).toBe('note_md');
    expect(existsSync(join(taskDir, '文档.md'))).toBe(true);
    expect(existsSync(join(taskDir, '文档_1.md'))).toBe(true);

    docs.saveContent(taskDir, id, first.fileName, '# A');
    docs.saveContent(taskDir, id, second.fileName, '# B');
    // 关键保证：后建的不会把先建的正文写穿。
    expect(readFileSync(join(taskDir, '文档.md'), 'utf8')).toBe('# A');
    expect(readFileSync(join(taskDir, '文档_1.md'), 'utf8')).toBe('# B');
    expect(docs.read(id, '文档.md').content).toBe('# A');
    expect(docs.read(id, '文档_1.md').content).toBe('# B');
    // 写路径自己会清缓存，所以新文件立刻出现在清单里。
    expect(names(taskDir).sort()).toEqual(['文档.md', '文档_1.md']);
  });

  it('progress.md 不参与 _N 递增：再建两个文档后它仍是无后缀的 progress.md', () => {
    const { id, taskDir } = newTask('T');
    docs.ensureDefaultDocs(id, taskDir);
    docs.createNoteFile(taskDir); // 文档.md
    docs.createNoteFile(taskDir); // 文档_1.md
    const list = docs.listFiles(taskDir);
    expect(names(taskDir).sort()).toEqual(['progress.md', '文档.md', '文档_1.md']);
    expect(existsSync(paths.progressFile(taskDir))).toBe(true);
    expect(list[0]!.fileName).toBe('progress.md');
    expect(list[0]!.label).toBe('进展');
    // progress.md 改名是 no-op（标签固定「进展」）。
    expect(docs.renameFile(taskDir, 'progress.md', '随便改个名')).toBe('progress.md');
    expect(existsSync(paths.progressFile(taskDir))).toBe(true);
  });

  // --- 不变量 4：列表 = 目录扫描 + 缓存 ------------------------------------

  it('todo.json / 子目录 / 非文档文件不进文档清单', () => {
    const { taskDir } = newTask('T');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'todo.json'), '{}', 'utf8');
    writeFileSync(join(taskDir, '说明.txt'), 'ignored', 'utf8');
    writeFileSync(join(taskDir, '架构图.excalidraw'), '{"elements":[]}', 'utf8');
    mkdirSync(join(taskDir, 'thumbs'), { recursive: true });
    mkdirSync(join(taskDir, 'attachments'), { recursive: true });
    writeFileSync(join(taskDir, 'thumbs', 'x.thumb.png'), 'x', 'utf8');

    const list = docs.listFiles(taskDir);
    expect(list.map((f) => f.fileName)).toEqual(['架构图.excalidraw']);
    expect(list[0]!.kind).toBe('drawing');
    expect(list[0]!.label).toBe('架构图');
  });

  // --- 不变量 3：先写文件 -------------------------------------------------

  it('writeToFile 把进展文档镜像到 {taskDir}/progress.md', () => {
    const { taskDir } = newTask('T');
    docs.writeToFile(taskDir, 'progress.md', '# hi');
    const path = paths.progressFile(taskDir);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('# hi');
  });

  it('writeToFile 把文档镜像到 {taskDir}/{label}.md', () => {
    const { taskDir } = newTask('T');
    docs.writeToFile(taskDir, '会议记录.md', '# 议程');
    const path = paths.noteFile(taskDir, '会议记录');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('# 议程');
  });

  it('removeFile 删掉磁盘文件，清单里也跟着消失', () => {
    const { taskDir } = newTask('T');
    const doc = docs.createNoteFile(taskDir, 'X');
    expect(existsSync(join(taskDir, 'X.md'))).toBe(true);
    docs.removeFile(taskDir, 'X.md');
    expect(existsSync(join(taskDir, 'X.md'))).toBe(false);
    expect(names(taskDir)).not.toContain(doc.fileName);
  });

  it('renameFile 搬文件：返回落地文件名，旧路径消失、内容跟着走', () => {
    const { taskDir } = newTask('T');
    docs.writeToFile(taskDir, 'Old.md', 'body');
    const landed = docs.renameFile(taskDir, 'Old.md', 'New');
    expect(landed).toBe('New.md');
    expect(existsSync(join(taskDir, 'Old.md'))).toBe(false);
    expect(readFileSync(join(taskDir, 'New.md'), 'utf8')).toBe('body');
    expect(names(taskDir)).toEqual(['New.md']);
    // 标签直接取自分配到的文件名 —— 没有「标签改了、文件没动」的中间态。
    expect(docs.listFiles(taskDir)[0]!.label).toBe('New');
    // 源文件不存在时原样返回，文档仍然读得到。
    expect(docs.renameFile(taskDir, 'Old.md', 'Newer')).toBe('Old.md');
  });

  it('renameFile 撞上已有目标时不覆盖对方，递增成 {新标签}_1', () => {
    const { id, taskDir } = newTask('T');
    const a = docs.createNoteFile(taskDir, 'A');
    const b = docs.createNoteFile(taskDir, 'B');
    docs.saveContent(taskDir, id, a.fileName, '# A');
    docs.saveContent(taskDir, id, b.fileName, '# B');

    expect(docs.renameFile(taskDir, 'A.md', 'B')).toBe('B_1.md');
    // 关键保证：B 的正文没被写穿，A 的正文换了个名字留住。
    expect(readFileSync(join(taskDir, 'B.md'), 'utf8')).toBe('# B');
    expect(readFileSync(join(taskDir, 'B_1.md'), 'utf8')).toBe('# A');
    expect(names(taskDir).sort()).toEqual(['B.md', 'B_1.md']);
  });

  // --- 已知缺陷（it.fails）：改成自己原来的名字不该被当成撞名 ---------------
  //
  // allocateFileName() 的 taken 参数契约是「同一任务下**其它**文档已占用的名字」，
  // selfFile 才是「这一行自己不算冲突」的逃生口（见 paths.ts 的注释，绘制那边
  // DrawingStore.claimedPaths(todoId, exceptId) 也确实排除了自身）。
  //
  // 但 DocumentStore.renameFile()（src/main/documents.ts:139）传的是
  // files.takenNames(taskDir) —— 那是目录扫描结果，**必然包含正在改名的这个
  // 文件自己**。allocateFileName 的 free() 先判 !taken.has(name)，selfFile 根本
  // 没机会生效，于是「标签没变」也被判成重名，白白改名。
  //
  // 实测 renameFile(taskDir, 'B.md', 'B') 返回 'B_2.md'：文件被搬走，标签从
  // 「B」静默变成「B_1」/「B_2」。渲染层在 DocumentsView.tsx:236 用
  // `if (next === tab.label) return;` 挡住了「原样重输一遍」这条主路径，所以
  // 平时碰不到；但只要输入的标题 slugify 之后仍等于原文件名（比如 tab 标签是
  // A_B、用户输入「A B」），就会命中。修法是 taken 排除自身
  // （takenNames(taskDir) 去掉 fileName），修好后把 it.fails 改回 it。
  // 改成自己原来的名字必须是 no-op：taken 排除自身（DocumentStore.otherNames），
  // 否则同一个 slug 被判成撞名，凭空变成 B_1.md / B_2.md。渲染层只在标签字符串
  // 完全相同时才挡住，而标签「A_B」+ 输入「A B」slugify 后相同，仍会走到这里。
  it('改成自己原来的名字是 no-op，不会凭空变成 B_1', () => {
    const { taskDir } = newTask('T');
    docs.createNoteFile(taskDir, 'B');
    expect(docs.renameFile(taskDir, 'B.md', 'B')).toBe('B.md');
    expect(names(taskDir)).toEqual(['B.md']);
  });

  it('slugify 后与原文件名相同的标题也算 no-op', () => {
    const { taskDir } = newTask('T');
    docs.createNoteFile(taskDir, 'A B');
    expect(docs.renameFile(taskDir, 'A_B.md', 'A B')).toBe('A_B.md');
    expect(names(taskDir)).toEqual(['A_B.md']);
  });
});

describe('DocumentStore 扫描缓存', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let todosDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-cache-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    todosDir = join(dir, 'todos');
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listFiles 在 TTL 内不重扫（可能读到旧结果），refreshFiles 才重读目录', () => {
    // 冻结时钟 + 长 TTL，让「缓存有没有生效」变成确定性断言，而不是靠跑得快。
    const clock = { t: 1_700_000_000_000 };
    const docs = new DocumentStore(handle.db, new TaskFileIndex(60_000, () => clock.t));
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(todosDir, paths.slugify(t.title), t.id);
    docs.ensureDefaultDocs(t.id, taskDir);

    expect(docs.listFiles(taskDir).map((f) => f.fileName)).toEqual(['progress.md']);
    // 绕过 store 直接在目录里丢一个文件。
    writeFileSync(join(taskDir, '外部.md'), '# 外部', 'utf8');
    // 缓存期内 listFiles 不重扫 —— 允许看到旧结果。
    expect(docs.listFiles(taskDir)).toHaveLength(1);
    // refreshFiles 清缓存后重读，新文件立刻可见。
    const refreshed = docs.refreshFiles(taskDir);
    expect(refreshed.map((f) => f.fileName)).toEqual(['progress.md', '外部.md']);
    const ext = refreshed.find((f) => f.fileName === '外部.md')!;
    expect(ext.label).toBe('外部');
    expect(ext.kind).toBe('note_md');
    expect(ext.sizeBytes).toBe(Buffer.byteLength('# 外部', 'utf8'));
    // 手工删掉的文件，刷新后消失。
    rmSync(join(taskDir, '外部.md'));
    expect(docs.refreshFiles(taskDir).map((f) => f.fileName)).toEqual(['progress.md']);
  });
});

describe('LinkStore CRUD（schema v21）', () => {
  let dir: string;
  let handle: ReturnType<typeof openDb>;
  let repo: TodoRepo;
  let links: LinkStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-list-links-'));
    handle = openDb(join(dir, 'db.sqlite'));
    repo = new TodoRepo(handle.db);
    links = new LinkStore(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('add / get / list / remove 全链路', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const link = links.add(t.id, 'https://google.com', 'Google', '搜索引擎');
    expect(link.todoId).toBe(t.id);
    expect(link.url).toBe('https://google.com');
    expect(link.title).toBe('Google');
    expect(link.description).toBe('搜索引擎');
    expect(links.get(link.id)).toEqual(link);
    expect(links.get('nope')).toBeNull();

    const second = links.add(t.id, 'https://example.com', 'Example');
    // list 按添加顺序（旧 → 新）。created_at 同毫秒时排序退化成随机 ULID，
    // 所以先把两个时间戳钉死，让顺序这条保证可断言。
    handle.db.prepare('UPDATE todo_links SET created_at = ? WHERE id = ?').run(1, link.id);
    handle.db.prepare('UPDATE todo_links SET created_at = ? WHERE id = ?').run(2, second.id);
    expect(links.list(t.id).map((l) => l.id)).toEqual([link.id, second.id]);

    links.remove(link.id);
    expect(links.get(link.id)).toBeNull();
    expect(links.list(t.id).map((l) => l.id)).toEqual([second.id]);
    // 幂等：删掉不存在的行不报错。
    expect(() => links.remove(link.id)).not.toThrow();
  });

  it('链接不是文档：不占任务目录、不进文档清单', () => {
    const t = repo.create({ title: 'T' }, 'x');
    const taskDir = paths.uniqueTodoDir(join(dir, 'todos'), paths.slugify(t.title), t.id);
    const docs = new DocumentStore(handle.db);
    docs.ensureDefaultDocs(t.id, taskDir);
    links.add(t.id, 'https://google.com', 'Google');

    // 链接没有文件，所以吃不了「文件名 = 标签」那套规则，也不会出现在
    // 文档工作区里 —— 旧用例的 kind === 'link' 分支就是这么消失的。
    expect(docs.refreshFiles(taskDir).map((f) => f.fileName)).toEqual(['progress.md']);
  });
});
