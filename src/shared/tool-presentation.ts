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
  | 'todo_list'
  | 'todo_get'
  | 'todo_create'
  | 'todo_update'
  | 'subtasks_list'
  | 'todo_planForToday'
  | 'todo_unplan'
  | 'todo_delete'
  | 'todo_restore'
  | 'todo_batchUpdate'
  | 'todo_search'
  | 'todo_stats'
  | 'content_readBody'
  | 'content_writeBody'
  | 'content_history'
  | 'content_restoreVersion'
  | 'drawing_list'
  | 'drawing_read'
  | 'drawing_save'
  | 'drawing_delete'
  | 'drawing_setThumb'
  | 'inbox_attach'
  | 'inbox_attachBlob'
  | 'conversation_list'
  | 'conversation_create'
  | 'conversation_rename'
  | 'conversation_archive'
  | 'conversation_unarchive'
  | 'conversation_delete'
  | 'conversation_history'
  | 'ai_health'
  | 'ai_models'
  | 'ai_stats'
  | 'app_currentContext'
  | 'web_search'
  | 'web_fetch';

const kindByTool: Record<ToolName, ToolCallKind> = {
  'todo_list': 'search',
  'todo_get': 'read',
  'todo_create': 'edit',
  'todo_update': 'edit',
  'subtasks_list': 'search',
  'todo_planForToday': 'edit',
  'todo_unplan': 'edit',
  'todo_delete': 'delete',
  'todo_restore': 'edit',
  'todo_batchUpdate': 'edit',
  'todo_search': 'search',
  'todo_stats': 'other',
  'content_readBody': 'read',
  'content_writeBody': 'edit',
  'content_history': 'read',
  'content_restoreVersion': 'edit',
  'drawing_list': 'read',
  'drawing_read': 'read',
  'drawing_save': 'edit',
  'drawing_delete': 'delete',
  'drawing_setThumb': 'edit',
  'inbox_attach': 'edit',
  'inbox_attachBlob': 'edit',
  'conversation_list': 'read',
  'conversation_create': 'edit',
  'conversation_rename': 'edit',
  'conversation_archive': 'delete',
  'conversation_unarchive': 'edit',
  'conversation_delete': 'delete',
  'conversation_history': 'read',
  'ai_health': 'other',
  'ai_models': 'other',
  'ai_stats': 'other',
  'app_currentContext': 'read',
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
 *  - read* / draw* / content_readBody → `card: 'read'` (ReadBlock)
 *  - content_writeBody              → `card: 'diff'` (DiffBlock)
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
    case 'todo_list':
    case 'subtasks_list':
      return todosListToSearch(toolName, result);
    case 'todo_search':
      return ftsHitsToSearch(result);
    case 'todo_get':
      return todoToRead(args, result);
    case 'content_readBody':
      return markdownToRead(args, result);
    case 'content_history':
      return contentHistoryToRead(result);
    case 'drawing_read':
      return drawingToRead(args, result);
    case 'drawing_list':
      return drawingListToGeneric(result);
    case 'content_writeBody':
      return writeBodyToDiff(args, result);
    default:
      return genericResult(toolName, result);
  }
}

/** One-line human-readable summary of a tool call for the collapsed row.
 *  Prefers the resolved subject (e.g. the TODO title from the result) over a
 *  raw id arg, so `todo_planForToday({id})` reads "晚上请客" once the result
 *  arrives — not "01M2G6H1JP". For list/search/stats tools it returns a
 *  count. Returns '' when nothing readable is available, in which case the
 *  row shows just its title. */
export function summarizeToolCall(
  toolName: string,
  args: unknown,
  result: unknown,
  ok: boolean,
): string {
  if (!ok) return '';
  const a = typeof args === 'object' && args !== null
    ? args as Record<string, unknown>
    : undefined;
  // DSH-native intent slot: when the model fills `description`, prefer it over
  // the per-tool structured subject. This is the UI hook for the
  // cordis.yml "工具调用风格" prompt rule ("调起任何工具前先写一句中文意图")
  // and the DSH primitives' SUMMARY_KEYS (which already put `description`
  // first for bash/code). A short Chinese phrase here makes the collapsed
  // row read like "查询 TODO · 看看本周到期" instead of "查询 TODO · {…}".
  if (a) {
    const desc = stringField(a, 'description');
    if (desc) return truncate(desc, 60);
  }
  const resultTitle = (): string | undefined => stringField(result, 'title');
  switch (toolName) {
    case 'todo_create':
    case 'todo_update': {
      const t = stringField(a, 'title') ?? resultTitle();
      return t ? truncate(t, 60) : '';
    }
    case 'todo_get':
    case 'todo_planForToday':
    case 'todo_unplan': {
      const t = resultTitle();
      return t ? truncate(t, 60) : '';
    }
    case 'todo_delete':
    case 'todo_restore':
    case 'conversation_archive':
    case 'conversation_unarchive':
    case 'conversation_delete':
    case 'drawing_delete':
    case 'content_restoreVersion':
    case 'drawing_setThumb':
      // result is {ok:true}; no subject to surface — the title alone suffices.
      return '';
    case 'todo_list':
    case 'subtasks_list':
    case 'content_history': {
      const n = asArray(result).length;
      if (n === 0) return '';
      const unit = toolName === 'content_history' ? '个版本' : '项';
      return `${n} ${unit}`;
    }
    case 'todo_batchUpdate': {
      const ids = parseIdList(a?.['ids']);
      const n = Array.isArray(result) ? result.length : ids.length;
      return n > 0 ? `${n} 项` : '';
    }
    case 'conversation_list': {
      const convs = result && typeof result === 'object'
        ? asArray((result as Record<string, unknown>)['conversations'])
        : [];
      return convs.length > 0 ? `${convs.length} 个会话` : '';
    }
    case 'conversation_history': {
      const n = asArray(result).length;
      return n > 0 ? `${n} 轮` : '';
    }
    case 'todo_search':
    case 'web_search':
      return truncate(stringField(a, 'query') ?? '', 60);
    case 'web_fetch':
      return truncate(stringField(a, 'url') ?? '', 80);
    case 'todo_stats': {
      const w = numberField(a, 'windowDays');
      return w != null ? `${w} 天` : '';
    }
    case 'content_readBody': {
      const v = numberField(result, 'version');
      return v != null ? `版本 ${v}` : '';
    }
    case 'content_writeBody': {
      const md = stringField(a, 'markdown') ?? '';
      const line = firstNonEmptyLine(md);
      return line ? truncate(line, 60) : '';
    }
    case 'drawing_list': {
      const n = asArray(result).length;
      return n > 0 ? `${n} 张画板` : '';
    }
    case 'drawing_save':
      return truncate(stringField(a, 'title') ?? stringField(result, 'title') ?? '', 60);
    case 'inbox_attach':
    case 'inbox_attachBlob':
      return truncate(
        stringField(a, 'filename') ?? stringField(result, 'filename') ?? '',
        60,
      );
    case 'conversation_create': {
      const conv = result && typeof result === 'object'
        ? (result as Record<string, unknown>)['conversation']
        : undefined;
      return truncate(
        stringField(a, 'title') ?? stringField(conv, 'title') ?? '',
        60,
      );
    }
    case 'conversation_rename':
      return truncate(stringField(a, 'title') ?? '', 60);
    default:
      return '';
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function parseIdList(v: unknown): string[] {
  let raw = v;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

function kindFor(toolName: string): ToolCallKind {
  return (kindByTool as Record<string, ToolCallKind>)[toolName] ?? 'other';
}

function titleFor(toolName: string): string {
  // Friendly Chinese label for the card title; falls back to the raw toolName.
  const map: Record<string, string> = {
    'todo_list': '查询 TODO',
    'todo_get': '查看 TODO',
    'todo_create': '新建 TODO',
    'todo_update': '更新 TODO',
    'subtasks_list': '查询子任务',
    'todo_planForToday': '安排到今天',
    'todo_unplan': '移出今日',
    'todo_delete': '删除 TODO',
    'todo_restore': '恢复 TODO',
    'todo_batchUpdate': '批量更新',
    'todo_search': '搜索 TODO',
    'todo_stats': '统计',
    'content_readBody': '读取正文',
    'content_writeBody': '写入正文',
    'content_history': '版本历史',
    'content_restoreVersion': '恢复版本',
    'drawing_list': '查看画板',
    'drawing_read': '读取画板',
    'drawing_save': '保存画板',
    'drawing_delete': '删除画板',
    'drawing_setThumb': '更新缩略图',
    'inbox_attach': '添加附件',
    'inbox_attachBlob': '添加附件',
    'conversation_list': '列出会话',
    'conversation_create': '新建会话',
    'conversation_rename': '重命名会话',
    'conversation_archive': '归档会话',
    'conversation_unarchive': '取消归档',
    'conversation_delete': '删除会话',
    'conversation_history': '会话历史',
    'ai_health': '检查 AI',
    'ai_models': 'AI 模型',
    'ai_stats': 'AI 统计',
    'app_currentContext': '当前焦点',
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

// ─── todo.* / subtasks_list → SearchMatchesResultView ────────────────────

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

// ─── todo_get / content_readBody / drawing_read → ReadResultView ────────

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
  return genericResult('drawing_list', result);
}

// ─── content_writeBody → DiffResultView ─────────────────────────────────

function writeBodyToDiff(args: unknown, result: unknown): ToolResultView {
  // L5-A: dsh-runtime's content_writeBody.execute snapshots the previous
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
