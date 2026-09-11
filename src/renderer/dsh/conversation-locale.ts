/** Chinese locale seat for the vendored DSH conversation components.
 *
 *  DSH's `conversation`-namespace dictionaries ship in sealed bundles we don't
 *  host (ui-conversation / ui-tool / ui-chat `./client` subpaths are type-only
 *  + cordis `apply`). The `common` namespace (`copy` / `copied` / `collapse` /
 *  `expand` / `markdown.footnotes`) IS augmented into the compilation graph by
 *  the `import type {} from '@deepseek-ai/dsh-client-locale/client'` line in
 *  `ui-chat/contract/slots.ts`, so those keys typecheck — but their RUNTIME
 *  Chinese strings still need a source. This module is that source.
 *
 *  One flat Chinese table plus a `{name}`-template resolver, cast to
 *  `TranslateNS<'conversation'>` so the vendored ToolRow / ReasoningRow /
 *  primitive-labels accept it without each call site carrying its own table.
 *  Keys mirror the union the vendored components actually consult (enumerated
 *  from ToolRow.tsx / ReasoningRow.tsx / primitive-labels.ts /
 *  terminal-card-model.ts); a missed key falls back to the key itself so a gap
 *  is visible, not a crash. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from './ui-tool/tool/models/primitive-labels'

// Self-contained common-namespace pull-in (redundant with ui-chat/contract/
// slots.ts, but harmless and keeps this module standalone). Type-only, elided
// at runtime — no cordis plugin is loaded.
import type {} from '@deepseek-ai/dsh-client-locale/client'

const ZH: Record<string, string> = {
  // ── common (cross-feature) ──────────────────────────────────────────────
  copy: '复制',
  copied: '已复制',
  collapse: '折叠',
  expand: '展开',
  'markdown.footnotes': '脚注',

  // ── row / message ───────────────────────────────────────────────────────
  'row.running': '正在运行',
  'row.failed': '失败',
  'row.stopped': '已停止',
  'row.input': '输入',
  'row.output': '输出',
  'row.inspect': '检查',
  'message.think': '思考过程',

  // ── diff card ────────────────────────────────────────────────────────────
  'diff.collapseAria': '折叠',
  'diff.expandAria': '展开 {count} 行',
  'diff.expandRest': '展开 {count} 行',
  'diff.files.one': '{count} 个文件',
  'diff.files.other': '{count} 个文件',

  // ── read card ────────────────────────────────────────────────────────────
  'read.window': '显示 {shown} / 共 {total} 行',
  'read.collapseAria': '折叠',
  'read.expandAria': '展开 {count} 行',
  'read.expandRest': '展开 {count} 行',

  // ── search card ──────────────────────────────────────────────────────────
  'search.paths': '{total} 个路径',
  'search.paths.truncated': '显示 {shown} / 共 {total} 个路径',
  'search.matches': '{total} 个匹配 · {files} 个文件',
  'search.matches.truncated': '显示 {shown} / 共 {total} 个匹配 · {files} 个文件',
  'search.noResults': '（无匹配）',
  'search.collapseAria': '折叠',
  'search.expandAria': '展开 {count} 行',
  'search.expandRest': '展开 {count} 行',

  // ── web card ──────────────────────────────────────────────────────────────
  'web.noResults': '（无结果）',
  'web.sourcesTruncated': '结果被截断',
  'web.http': 'HTTP',
  'web.contentTruncated': '内容被截断',

  // ── terminal card ─────────────────────────────────────────────────────────
  'terminal.signal': '信号 {signal}',
  'terminal.exitCode': '退出码 {code}',
  'terminal.running': '正在运行',
  'terminal.failed': '失败',
  'terminal.done': '完成',
  'terminal.noOutput': '（无输出）',
  'terminal.collapseAria': '折叠',
  'terminal.expandAria': '展开 {n} 行',
  'terminal.expandRest': '展开 {n} 行',
  'terminal.sendInput': '发送输入',
  'terminal.session': '会话 {sessionId}',
}

function resolve(key: string, params?: Record<string, unknown>): string {
  const tpl = ZH[key]
  if (tpl === undefined) return key
  if (params === undefined) return tpl
  return tpl.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name] ?? '') : match,
  )
}

/** The conversation locale seat consumed by every vendored DSH component we
 *  render (ToolRow, ReasoningRow, and the card primitives' label builders). */
export const conversationT = resolve as unknown as TranslateNS<'conversation'>

/** Reference-stable Markdown chrome labels for `MarkdownText` — built from the
 *  same locale seat so copy/copied/footnotes stay in lockstep with the tool
 *  cards. Module-level because `conversationT` is already stable. Mirrors DSH
 *  AssistantMarkdown's `codeLabels` useMemo pattern. */
export const CONVERSATION_MARKDOWN_LABELS: MarkdownLabels = markdownLabels(conversationT)
