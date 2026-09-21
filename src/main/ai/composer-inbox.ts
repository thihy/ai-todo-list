// AI composer 附件 inbox helper。
//
// 把 AI composer（AI 助手输入框的「+」按钮、中心 Composer→AIPane 图片）的
// 附件集中存到 <rootDir>/.todo-list/<DSH_WORKSPACE_SUBDIR>/<COMPOSER_INBOX_SUBDIR>/
// 下，文件命名 c-<convId>-<ulid>-<basename>，跟一个 sidecar JSON 索引配对。
//
// 设计要点：
//   - 文件前缀 `c-` 区分本模块写入的文件与 DSH `inbox_attach` 工具（写到
//     <rootDir>/.todo-list/inbox-attachments/，不同父目录）；
//   - 索引文件 `.composer-index.json` 在同层，schema: { version, conversations }，
//     一次写入锁防 read-modify-write 竞态；
//   - 删除 conv 时按索引清理物理文件 + 索引条目；
//   - 不主动 sweep 孤儿文件（崩溃遗留），DSH `read` 仍能从那里读，让用户
//     自己清理；后续可加 startup sweep。
//
// 调用方：
//   - src/main/index.ts 的 `app.pickFile` handler（dialog → copy）
//   - src/main/index.ts 的 `ai.attachment.importBlob` handler（Blob → write）
//   - src/main/ipc/ai-handlers.ts 的 `ai.conversation.delete` / `deleteMany` /
//     `sweep` 路径（cleanupForConv）

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { newId } from '../db/schema';
import { COMPOSER_INBOX_SUBDIR, DSH_WORKSPACE_SUBDIR } from '../../shared/constants';

export interface InboxedFile {
  /** 绝对路径 = <dsh_workspace>/<inbox>/c-<convId>-<ulid>-<basename>。AI 看到的引用就是这串。 */
  path: string;
  /** 用户原始文件名（用于 UI chip + prompt `[attached: name]` 头）。 */
  name: string;
  mime: string;
  size: number;
}

interface ComposerIndex {
  version: 1;
  /** convId → 该 conv 注册的绝对路径数组。 */
  conversations: Record<string, string[]>;
}

const INDEX_FILENAME = '.composer-index.json';
const FILE_PREFIX = 'c-'; // 与 DSH `inbox_attach` 工具（不同目录）命名约定区分

let _inboxDir: string | null = null;
let _indexPath: string | null = null;
/** 串行化所有「读 → 改 → 写」索引操作的 promise 链。多次 commit 排队，
 *  避免 read-modify-write 竞态。 */
let _writeChain: Promise<unknown> = Promise.resolve();

function ensureDirs(rootDir: string): { inboxDir: string; indexPath: string } {
  if (_inboxDir && _indexPath) return { inboxDir: _inboxDir, indexPath: _indexPath };
  const inboxDir = join(rootDir, DSH_WORKSPACE_SUBDIR, COMPOSER_INBOX_SUBDIR);
  mkdirSync(inboxDir, { recursive: true });
  const indexPath = join(inboxDir, INDEX_FILENAME);
  _inboxDir = inboxDir;
  _indexPath = indexPath;
  return { inboxDir, indexPath };
}

/** 初始化（暴露给 main 启动路径，便于显式触发 mkdir）。
 *  幂等，可以多次调用。 */
export function initComposerInbox(rootDir: string): void {
  ensureDirs(rootDir);
}

/** 构造目标路径。重名时 basename 加 `<ulid>` 后缀避免冲突。 */
function resolveTarget(inboxDir: string, conversationId: string, srcName: string): { filename: string; target: string } {
  const ulid = newId();
  const safeBase = basename(srcName);
  const filename = `${FILE_PREFIX}${conversationId}-${ulid}-${safeBase}`;
  return { filename, target: join(inboxDir, filename) };
}

/** 从文件路径复制到 inbox。返回 {path, name, mime, size}，path 是 inbox 内绝对路径。 */
export async function copyPathToInbox(
  rootDir: string,
  srcPath: string,
  name: string,
  mime: string,
  conversationId: string | null,
): Promise<InboxedFile> {
  const { inboxDir } = ensureDirs(rootDir);
  const { target } = resolveTarget(inboxDir, conversationId ?? 'draft', name);
  const buf = readFileSync(srcPath);
  writeFileSync(target, buf);
  const result: InboxedFile = { path: target, name, mime, size: buf.byteLength };
  await indexForConv(rootDir, conversationId, [target]);
  return result;
}

/** 直接把 Buffer / Uint8Array 写到 inbox（用于 dataUrl → bytes 的 importBlob 路径）。
 *  dataUrl 解码由 caller 完成，这里只负责落盘 + 注册索引。 */
export async function writeBlobToInbox(
  rootDir: string,
  name: string,
  mime: string,
  buf: Buffer | Uint8Array,
  conversationId: string | null,
): Promise<InboxedFile> {
  const { inboxDir } = ensureDirs(rootDir);
  const { target } = resolveTarget(inboxDir, conversationId ?? 'draft', name);
  writeFileSync(target, buf);
  const size = buf.byteLength;
  const result: InboxedFile = { path: target, name, mime, size };
  await indexForConv(rootDir, conversationId, [target]);
  return result;
}

/** 读 sidecar JSON。文件不存在 / 损坏时返回空索引（不抛错）。 */
function loadIndex(indexPath: string): ComposerIndex {
  if (!existsSync(indexPath)) return { version: 1, conversations: {} };
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ComposerIndex>;
    if (parsed && parsed.version === 1 && parsed.conversations && typeof parsed.conversations === 'object') {
      return { version: 1, conversations: parsed.conversations as Record<string, string[]> };
    }
    return { version: 1, conversations: {} };
  } catch {
    return { version: 1, conversations: {} };
  }
}

/** 原子写入：写 temp + rename 避免半截文件。失败时静默吞——索引丢失只意味着
 *  会话删除时无法枚举文件，DSH `read` 仍能从磁盘读到孤儿文件。 */
function saveIndex(indexPath: string, idx: ComposerIndex): void {
  const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(idx, null, 2));
    renameSync(tmp, indexPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

/** 注册路径到 conv 的索引项。`null` convId 落到 "draft" key，待后续
 *  `relinkDraft(convId, paths)` 时挪到正式 conv 下。 */
export async function indexForConv(
  rootDir: string,
  conversationId: string | null,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { indexPath } = ensureDirs(rootDir);
  const key = conversationId ?? 'draft';
  _writeChain = _writeChain.then(() => {
    const idx = loadIndex(indexPath);
    const list = idx.conversations[key] ?? [];
    // 去重，保持追加顺序
    const set = new Set(list);
    for (const p of paths) set.add(p);
    idx.conversations[key] = Array.from(set);
    saveIndex(indexPath, idx);
  });
  await _writeChain;
}

/** 把 draft 期间临时挂的路径挪到正式 convId 下。删除 draft key。 */
export async function relinkDraft(rootDir: string, conversationId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { indexPath } = ensureDirs(rootDir);
  _writeChain = _writeChain.then(() => {
    const idx = loadIndex(indexPath);
    const draftList = idx.conversations['draft'] ?? [];
    const draftSet = new Set(draftList);
    const cur = idx.conversations[conversationId] ?? [];
    const curSet = new Set(cur);
    for (const p of paths) {
      if (draftSet.has(p)) draftSet.delete(p);
      curSet.add(p);
    }
    if (draftSet.size === 0) delete idx.conversations['draft'];
    else idx.conversations['draft'] = Array.from(draftSet);
    idx.conversations[conversationId] = Array.from(curSet);
    saveIndex(indexPath, idx);
  });
  await _writeChain;
}

/** 删除指定 conv 的所有 inbox 文件 + 索引条目。文件不在磁盘上时静默吞。 */
export async function cleanupForConv(rootDir: string, conversationId: string): Promise<void> {
  const { indexPath } = ensureDirs(rootDir);
  _writeChain = _writeChain.then(() => {
    const idx = loadIndex(indexPath);
    const paths = idx.conversations[conversationId] ?? [];
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* best-effort — file may already be gone */ }
    }
    if (paths.length > 0) delete idx.conversations[conversationId];
    saveIndex(indexPath, idx);
  });
  await _writeChain;
}

/** 仅用于测试 / 内部：列出某个 convId 注册的所有路径（不做磁盘扫描）。 */
export function listPathsForConv(rootDir: string, conversationId: string): string[] {
  const { indexPath } = ensureDirs(rootDir);
  const idx = loadIndex(indexPath);
  return idx.conversations[conversationId] ?? [];
}

/** 测试用：清空模块内缓存（让 ensureDirs 重新读 rootDir）。 */
export function _resetForTests(): void {
  _inboxDir = null;
  _indexPath = null;
  _writeChain = Promise.resolve();
}