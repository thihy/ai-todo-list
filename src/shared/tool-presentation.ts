// Tool presentation — maps a single (toolName, args, result, ok) tuple onto the
// ToolCallView / ToolResultView render-intent vocabulary, mirroring DSH
// ToolDefinition.presentCall / presentResult.
//
// LIVES IN SHARED so the main process can declare presentCall / presentResult
// on every defineTool() (matching DSH web frontend's tool-presentation
// contract) AND the renderer can use the same code as a fallback when the
// wire did not carry a pre-computed view. Pure functions, no React.
//
// The DSH frontend ships the same logic as part of each tool's `presentCall
// / `presentResult` (in main). We centralise it here instead of duplicating
// 35 branches across main + renderer so:
//   (a) the main-side defineTool and renderer-side fallback stay in lockstep
//       (no "fix it in main but forget the renderer" drift), and
//   (b) tool intent is a UI concern owned by a single source of truth.
//
// `presentToolCall` is consulted by main when the tool fires a `tool/call`
// event (presentCall hook) and by the renderer as a fallback. The renderer
// always calls `presentToolResult` at render time — either from meta on the
// wire or from the local fallback.

import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  ToolCallView,
  ToolResultView,
  ToolCallKind,
  ReadFileLine,
  SearchFileMatches,
  SearchLineMatch,
  FileDiff,
} from '@deepseek-ai/dsh-tools';

// ContentBlock shape is a discriminated union from `@deepseek-ai/dsh-llm`. We
// never inspect fields beyond `type: 'text' | text` for generic rendering, so
// the literal `{ type: 'text', text }` is constructed inline and cast through
// `unknown` to satisfy the union. Importing `ContentBlock` directly would
// force callers to depend on dsh-llm transitively.

// ContentBlock re-export — kept here so callers don't have to chase the import
// when they extend the presentation layer.
export type { ContentBlock } from '@deepseek-ai/dsh-llm';

/** Recover the raw tool return value from the rendered ContentBlock[] that
 *  DSH carries on a `tool/result` session event. Every domain tool uses
 *  `jsonOutput`, whose `render` produces `[{type:'text', text: JSON.stringify(value, null, 2)}]`
 *  (the model-visible form). The renderer needs the ORIGINAL value — not the
 *  wrapped block array — to feed `presentToolResult`; otherwise the card body
 *  degenerates to a `<pre>[{"type":"text","text":"..."}]</pre>` dump of the
 *  block array itself. Best-effort: a non-JSON text payload (e.g. an error
 *  message string) is returned as the plain string so `errorResult` can render
 *  it. `undefined`/empty content returns `undefined` (→ "失败" fallback). */
export function recoverToolResultValue(content: unknown): unknown {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type === 'text' && typeof first.text === 'string') {
    try { return JSON.parse(first.text); } catch { return first.text; }
  }
  return content;
}

/** Parse the `arguments` JSON string carried on a `tool/call` event into the
 *  args object the per-tool `presentResult` handlers expect (they read fields
 *  like `args.id` / `args.markdown`). DSH's `tool/call` `data.arguments` is a
 *  raw JSON string; passing it through un-parsed makes `stringField(args,…)`
 *  miss every field. Falls back to the raw string when the payload isn't valid
 *  JSON (defensive — a misbehaving model can emit malformed JSON). A non-string
 *  input is returned as-is. */
export function parseToolArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw === '') return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

export type ToolName =
  | 'todo.list'
  | 'todo.get'
  | 'todo.create'
  | 'todo.update'
  | 'subtasks.list'
  | 'todo.planForToday'
  | 'todo.unplan'
  | 'todo.delete'
  | 'todo.restore'
  | 'todo.batchUpdate'
  | 'todo.search'
  | 'todo.stats'
  | 'content.readBody'
  | 'content.writeBody'
  | 'content.history'
  | 'content.restoreVersion'
  | 'drawing.list'
  | 'drawing.read'
  | 'drawing.save'
  | 'drawing.delete'
  | 'drawing.setThumb'
  | 'inbox.attach'
  | 'inbox.attachBlob'
  | 'conversation.list'
  | 'conversation.create'
  | 'conversation.rename'
  | 'conversation.archive'
  | 'conversation.unarchive'
  | 'conversation.delete'
  | 'conversation.history'
  | 'ai.health'
  | 'ai.models'
  | 'ai.stats'
  | 'app.currentContext'
  | 'web_search'
  | 'web_fetch';

const kindByTool: Record<ToolName, ToolCallKind> = {
  'todo.list': 'search',
  'todo.get': 'read',
  'todo.create': 'edit',
  'todo.update': 'edit',
  'subtasks.list': 'search',
  'todo.planForToday': 'edit',
  'todo.unplan': 'edit',
  'todo.delete': 'delete',
  'todo.restore': 'edit',
  'todo.batchUpdate': 'edit',
  'todo.search': 'search',
  'todo.stats': 'other',
  'content.readBody': 'read',
  'content.writeBody': 'edit',
  'content.history': 'read',
  'content.restoreVersion': 'edit',
  'drawing.list': 'read',
  'drawing.read': 'read',
  'drawing.save': 'edit',
  'drawing.delete': 'delete',
  'drawing.setThumb': 'edit',
  'inbox.attach': 'edit',
  'inbox.attachBlob': 'edit',
  'conversation.list': 'read',
  'conversation.create': 'edit',
  'conversation.rename': 'edit',
  'conversation.archive': 'delete',
  'conversation.unarchive': 'edit',
  'conversation.delete': 'delete',
  'conversation.history': 'read',
  'ai.health': 'other',
  'ai.models': 'other',
  'ai.stats': 'other',
  'app.currentContext': 'read',
  'web_search': 'search',
  'web_fetch': 'fetch',
};

/** Pending-call card. DSH default shape: generic title + rawInput +
 *  kind/category. The renderer wraps it with the right card primitive. */
export function presentToolCall(
  toolName: string,
  args: unknown,
): ToolCallView {
  const kind = kindFor(toolName);
  return {
    card: 'generic',
    title: titleFor(toolName),
    rawInput: args,
    kind,
  };
}

/** Completed-call card. Each tool routes to the most natural render target:
 *  - read* / draw* / content.readBody → `card: 'read'` (ReadBlock)
 *  - content.writeBody              → `card: 'diff'` (DiffBlock)
 *  - *list / *search                → `card: 'search'` (SearchBlock, matches shape)
 *  - everything else                → `card: 'generic'` (JsonTree / JsonBlock)
 *
 *  Falls back gracefully on unknown shape or missing data: `card: 'generic'`
 *  with raw text content lets the JsonBlock carry whatever the model saw. */
export function presentToolResult(
  toolName: string,
  args: unknown,
  result: unknown,
  ok: boolean,
): ToolResultView {
  if (!ok || result == null) {
    return errorResult(toolName, result);
  }
  switch (toolName) {
    case 'todo.list':
    case 'subtasks.list':
      return todosListToSearch(toolName, result);
    case 'todo.search':
      return ftsHitsToSearch(result);
    case 'todo.get':
      return todoToRead(args, result);
    case 'content.readBody':
      return markdownToRead(args, result);
    case 'content.history':
      return contentHistoryToRead(result);
    case 'drawing.read':
      return drawingToRead(args, result);
    case 'drawing.list':
      return drawingListToGeneric(result);
    case 'content.writeBody':
      return writeBodyToDiff(args, result);
    default:
      return genericResult(toolName, result);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function kindFor(toolName: string): ToolCallKind {
  return (kindByTool as Record<string, ToolCallKind>)[toolName] ?? 'other';
}

function titleFor(toolName: string): string {
  // Friendly Chinese label for the card title; falls back to the raw toolName.
  const map: Record<string, string> = {
    'todo.list': '查询 TODO',
    'todo.get': '查看 TODO',
    'todo.create': '新建 TODO',
    'todo.update': '更新 TODO',
    'subtasks.list': '查询子任务',
    'todo.planForToday': '安排到今天',
    'todo.unplan': '移出今日',
    'todo.delete': '删除 TODO',
    'todo.restore': '恢复 TODO',
    'todo.batchUpdate': '批量更新',
    'todo.search': '搜索 TODO',
    'todo.stats': '统计',
    'content.readBody': '读取正文',
    'content.writeBody': '写入正文',
    'content.history': '版本历史',
    'content.restoreVersion': '恢复版本',
    'drawing.list': '查看画板',
    'drawing.read': '读取画板',
    'drawing.save': '保存画板',
    'drawing.delete': '删除画板',
    'drawing.setThumb': '更新缩略图',
    'inbox.attach': '添加附件',
    'inbox.attachBlob': '添加附件',
    'conversation.list': '列出会话',
    'conversation.create': '新建会话',
    'conversation.rename': '重命名会话',
    'conversation.archive': '归档会话',
    'conversation.unarchive': '取消归档',
    'conversation.delete': '删除会话',
    'conversation.history': '会话历史',
    'ai.health': '检查 AI',
    'ai.models': 'AI 模型',
    'ai.stats': 'AI 统计',
    'app.currentContext': '当前焦点',
    'web_search': '搜索网页',
    'web_fetch': '读取网页',
  };
  return map[toolName] ?? toolName;
}

function genericResult(_toolName: string, result: unknown): ToolResultView {
  // L5-A: never feed `undefined` / non-stringify-able to JsonBlock — it ends
  // up at `payload[Symbol.iterator]` / `.next()` and crashes with
  // "Cannot read properties of undefined (reading 'next')". Always project
  // to a JSON string first; JsonBlock parses it back.
  const text = result === undefined
    ? '{}'
    : typeof result === 'string'
      ? result
      : safeJson(result);
  return {
    card: 'generic',
    content: [{ type: 'text', text } as unknown as never],
  };
}

function errorResult(toolName: string, result: unknown): ToolResultView {
  const text = typeof result === 'string'
    ? result
    : result == null
      ? `${titleFor(toolName)} 失败`
      : safeJson(result);
  return {
    card: 'generic',
    title: `${titleFor(toolName)} — 失败`,
    content: [{ type: 'text', text } as unknown as never],
  };
}

// ─── todo.* / subtasks.list → SearchMatchesResultView ────────────────────

function todosListToSearch(
  toolName: string,
  result: unknown,
): ToolResultView {
  const todos = asArray(result);
  if (todos.length === 0) {
    return {
      card: 'search',
      shape: 'matches',
      title: `${titleFor(toolName)} — 空`,
      files: [],
      truncated: false,
      total: 0,
    };
  }
  const files: SearchFileMatches[] = todos.map((t) => {
    const title = stringField(t, 'title') ?? '(无标题)';
    const status = stringField(t, 'status') ?? '';
    const due = numberField(t, 'dueAt');
    const dueStr = due != null ? ` · ${formatDue(due)}` : '';
    return {
      path: `${status ? '[' + status + '] ' : ''}${title}${dueStr}`,
      matches: [{ lineNumber: 1, line: summaryLine(t) }],
    };
  });
  return {
    card: 'search',
    shape: 'matches',
    title: titleFor(toolName),
    files,
    truncated: false,
    total: todos.length,
  };
}

function ftsHitsToSearch(result: unknown): ToolResultView {
  const hits = asArray(result);
  const files: SearchFileMatches[] = hits.map((hit, idx) => {
    const title = stringField(hit, 'title') ?? '(无标题)';
    const snippet = stringField(hit, 'snippet') ?? '';
    const matches: SearchLineMatch[] = snippet
      ? [{ lineNumber: idx + 1, line: snippet }]
      : [{ lineNumber: idx + 1, line: title }];
    return { path: title, matches };
  });
  return {
    card: 'search',
    shape: 'matches',
    title: '搜索 TODO',
    files,
    truncated: false,
    total: hits.length,
  };
}

// ─── todo.get / content.readBody / drawing.read → ReadResultView ────────

function todoToRead(_args: unknown, result: unknown): ToolResultView {
  const title = stringField(result, 'title') ?? '(无标题)';
  const status = stringField(result, 'status');
  const lines: ReadFileLine[] = [];
  pushLine(lines, `标题: ${title}`);
  if (status) pushLine(lines, `状态: ${status}`);
  const priority = stringField(result, 'priority');
  if (priority) pushLine(lines, `优先级: ${priority}`);
  const due = numberField(result, 'dueAt');
  if (due != null) pushLine(lines, `截止: ${formatDue(due)}`);
  const body = stringField(result, 'body');
  if (body) pushLine(lines, '', body);
  return {
    card: 'read',
    title,
    path: title,
    offset: 1,
    lines,
    totalLines: lines.length,
  };
}

function markdownToRead(_args: unknown, result: unknown): ToolResultView {
  const md = stringField(result, 'markdown') ?? '';
  const version = numberField(result, 'version');
  const lines: ReadFileLine[] = md
    .split('\n')
    .map((line, i) => ({ number: i + 1, text: line }));
  return {
    card: 'read',
    title: '正文',
    path: 'body.md',
    offset: 1,
    lines,
    totalLines: lines.length,
    lang: 'markdown',
    ...(version != null ? {} : {}),
  };
}

function contentHistoryToRead(result: unknown): ToolResultView {
  const entries = asArray(result);
  const lines: ReadFileLine[] = [];
  entries.forEach((e) => {
    const id = stringField(e, 'id') ?? '';
    const savedAt = numberField(e, 'savedAt');
    const body = stringField(e, 'body') ?? '';
    lines.push({ number: lines.length + 1, text: `# version ${id}${savedAt ? ' · ' + new Date(savedAt).toISOString() : ''}` });
    body.split('\n').forEach((line) => pushLine(lines, line));
    pushLine(lines, '');
  });
  return {
    card: 'read',
    title: '版本历史',
    path: 'history.md',
    offset: 1,
    lines,
    totalLines: lines.length,
    lang: 'markdown',
  };
}

function drawingToRead(_args: unknown, result: unknown): ToolResultView {
  const text = safeJson(result);
  const lines: ReadFileLine[] = text
    .split('\n')
    .map((line, i) => ({ number: i + 1, text: line }));
  return {
    card: 'read',
    title: '画板内容',
    path: 'scene.json',
    offset: 1,
    lines,
    totalLines: lines.length,
    lang: 'json',
  };
}

function drawingListToGeneric(result: unknown): ToolResultView {
  return genericResult('drawing.list', result);
}

// ─── content.writeBody → DiffResultView ─────────────────────────────────

function writeBodyToDiff(args: unknown, result: unknown): ToolResultView {
  // L5-A: dsh-runtime's content.writeBody.execute snapshots the previous
  // body via md.readBody() and attaches it as __oldText on the result before
  // presentationMeta pass-through. Read it here so DiffBlock renders a real
  // red/green diff (instead of an all-additions "覆盖" view when oldText
  // is null). Falls back to null on first-write / missing-file — DiffBlock
  // handles null gracefully by treating the new content as a full replace.
  const id = stringField(args, 'id') ?? 'todo';
  const md = stringField(args, 'markdown') ?? '';
  const oldText = typeof result === 'object' && result !== null
    ? stringField(result, '__oldText') ?? null
    : null;
  const fileDiff: FileDiff = { path: `${id}/body.md`, oldText, newText: md };
  return {
    card: 'diff',
    title: `Write ${id}`,
    diffs: [fileDiff],
  };
}

// ─── tiny data-shape helpers ────────────────────────────────────────────

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function stringField(v: unknown, key: string): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = (v as Record<string, unknown>)[key];
  return typeof x === 'string' ? x : undefined;
}

function numberField(v: unknown, key: string): number | null | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = (v as Record<string, unknown>)[key];
  return typeof x === 'number' ? x : (x == null ? null : undefined);
}

function summaryLine(v: unknown): string {
  if (typeof v !== 'object' || v === null) return '';
  const obj = v as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj['priority'] === 'string') parts.push(`priority=${obj['priority']}`);
  if (typeof obj['tags'] === 'object' && Array.isArray(obj['tags'])) {
    const tags = (obj['tags'] as unknown[]).filter((t) => typeof t === 'string').join(', ');
    if (tags) parts.push(`tags=${tags}`);
  }
  if (typeof obj['parentId'] === 'string') parts.push(`parent=${obj['parentId']}`);
  return parts.join(' · ');
}

function formatDue(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pushLine(lines: ReadFileLine[], text: string): void;
function pushLine(lines: ReadFileLine[], text: string, alt: string): void;
function pushLine(lines: ReadFileLine[], text: string, alt?: string): void {
  lines.push({ number: lines.length + 1, text: alt ?? text });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// DiffHunk re-export — kept here so callers don't have to chase the import
// when they extend the presentation layer.
export type { DiffHunk };
