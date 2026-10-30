import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../../src/main/db/schema';
import { TodoRepo } from '../../src/main/db/todo-repo';
import { TaskDirectoryStore } from '../../src/main/files/task-directories';
import { DocumentStore, LinkStore } from '../../src/main/files/documents';
import { registerDocumentHandlers } from '../../src/main/ipc/document-handlers';

const harness = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, req: any) => any>(),
  pick: vi.fn(), open: vi.fn(), reveal: vi.fn(), broadcast: vi.fn() }));
vi.mock('../../src/main/ipc/router', () => ({
  register: (name: string, handler: any) => harness.handlers.set(name, handler),
  okResult: (data: unknown) => ({ ok: true, data }), failResult: (code: string, message: string) => ({ ok: false, code, message }),
}));
vi.mock('electron', () => ({ dialog: { showOpenDialog: harness.pick },
  BrowserWindow: { fromWebContents: () => null }, shell: { openPath: harness.open, showItemInFolder: harness.reveal } }));
vi.mock('../../src/main/ipc/broadcast', () => ({ broadcastDataChanged: harness.broadcast }));
vi.mock('../../src/main/git-history', () => ({ ensureGitRepo: async () => {}, commitAll: async () => null }));
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

describe('local document and link IPC', () => {
  let root: string; let db: ReturnType<typeof openDb>; let taskId: string; let taskDir: string; let links: LinkStore;
  const call = (name: string, req: any) => harness.handlers.get(name)!({ sender: {} }, req);
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'document-ipc-'));
    db = openDb(join(root, 'todos.db'));
    taskId = new TodoRepo(db.db).create({ title: '本地文件' }).id;
    const dirs = new TaskDirectoryStore(db.db, join(root, 'todos'));
    taskDir = dirs.resolve(taskId);
    links = new LinkStore(db.db);
    registerDocumentHandlers(new DocumentStore(db.db), links, (id) => dirs.resolve(id), join(root, 'todos'));
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  it('refresh invalidates lists and open content after external edits without DB documents', async () => {
    await call('document.list', { todoId: taskId });
    writeFileSync(join(taskDir, '外部.md'), 'first');
    let result = await call('document.refresh', { todoId: taskId });
    expect(result.data.files.map((f: any) => f.fileName)).toContain('外部.md');
    expect(harness.broadcast).toHaveBeenCalledWith('content');
    expect(harness.broadcast).toHaveBeenCalledWith('drawings');
    writeFileSync(join(taskDir, '外部.md'), 'latest');
    result = await call('document.read', { todoId: taskId, fileName: '外部.md' });
    expect(result.data.content).toBe('latest');
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_versions','drawings')").all()).toEqual([]);
  });
  it('picker and drag import copy files with collision protection and cancellation is a no-op', async () => {
    const path = join(root, '原文.md'); writeFileSync(path, '# source');
    harness.pick.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    const first = await call('document.import', { todoId: taskId });
    expect(first.data.files[0].fileName).toBe('原文.md');
    expect(harness.pick.mock.calls[0][0].filters[0].extensions).toEqual(['md', 'excalidraw']);
    const second = await call('document.import', { todoId: taskId, paths: [path] });
    expect(second.data.files[0].fileName).toBe('原文_1.md');
    expect(readFileSync(path, 'utf8')).toBe('# source');
    harness.pick.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect((await call('document.import', { todoId: taskId })).data.files).toEqual([]);
  });
  it('local links reference source files and invoke the requested OS action without copying', async () => {
    const path = join(root, '外部 PDF.pdf'); writeFileSync(path, 'pdf');
    harness.pick.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    const selected = await call('link.pickFile', {});
    expect(selected.data.url).toBe(pathToFileURL(path).href);
    const link = links.add(taskId, selected.data.url, selected.data.title);
    harness.open.mockResolvedValue('');
    expect((await call('link.openLocal', { id: link.id, action: 'open' })).ok).toBe(true);
    expect(harness.open).toHaveBeenCalledWith(path);
    expect((await call('link.openLocal', { id: link.id, action: 'reveal' })).ok).toBe(true);
    expect(harness.reveal).toHaveBeenCalledWith(path);
    expect(readdirSync(taskDir)).toEqual([]);
    const web = links.add(taskId, 'https://example.com');
    expect((await call('link.openLocal', { id: web.id, action: 'open' })).ok).toBe(false);
    expect((await call('link.openLocal', { id: link.id, action: 'bad' })).ok).toBe(false);
  });
});
