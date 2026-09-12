/** Adapter: map our `(toolName, args, result, ok, running)` presentation
 *  vocabulary onto the vendored DSH `ToolRow`'s `*CardModel` props.
 *
 *  We BYPASS `GenericToolCard` — its `*CardModel` builders
 *  (`diffCardModel` / `readCardModel` / `searchCardModel` / …) are tool-name-
 *  hardcoded for DSH's bash / read / write / grep / glob and read a DSH
 *  `ToolCallBlock` session node we don't host, so every `todo.*` /
 *  `content.*` / `drawing.*` call falls through to the generic path. Instead
 *  we feed `ToolRow` DIRECTLY: our `presentToolCall` / `presentToolResult`
 *  (src/shared/tool-presentation.ts) already project a `ToolCallView` /
 *  `ToolResultView`; this adapter reshapes the result view's discriminated
 *  union into the nested `{ card: { … } }` shapes ToolRow's card primitives
 *  expect. One line per card kind — no per-tool switch in the renderer.
 *
 *  This is the "对接" (connection) that lets AIPane drop ~280 lines of
 *  hand-rolled `ToolDispatchRow` / `ToolCardBody` / 5 label tables /
 *  `summarizeArgs` and consume the vendored row verbatim. */
import React, { useMemo } from 'react'
import {
  IconApiOutline14,
  IconBrowseOutline16,
  IconCodeOutline16,
  IconEditOutline16,
  IconSearchOutline16,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallKind, ToolResultView } from '@deepseek-ai/dsh-tools'
import { ToolRow } from './ui-tool/tool/components/ToolRow'
import type { DiffCardModel } from './ui-tool/tool/models/diff-card-model'
import type { ReadCardModel } from './ui-tool/tool/models/read-card-model'
import type { SearchCardModel } from './ui-tool/tool/models/search-card-model'
import type { ToolRowState, ToolRowVariant } from './ui-tool/tool/models/tool-call-model'
import { classifyTool } from './ui-tool/tool/models/tool-call-model'
import { webCardModelFromMeta, type WebCardModelProps } from './ui-tool/tool/models/web-card-model'
import { conversationT as t } from './conversation-locale'
import { presentToolCall, presentToolResult } from '../tool-presentation'

/** Variant leading icons (figma table), verbatim from GenericToolCard — all
 *  glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, React.ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/** Our `ToolCallKind` (provider-neutral) → DSH `ToolRowVariant`. `delete` /
 *  `move` have no DSH twin and land on `others`; `execute` → `bash`;
 *  `fetch` → `read` (matches DSH `web_fetch`'s own classification). */
const variantByKind: Record<ToolCallKind, ToolRowVariant> = {
  search: 'search',
  read: 'read',
  edit: 'edit',
  delete: 'others',
  move: 'others',
  execute: 'bash',
  fetch: 'read',
  other: 'others',
}

/** Card-model payload derived from a `ToolResultView`. A `null` field means
 *  ToolRow falls through to the generic input/output body. */
interface CardModels {
  diff: DiffCardModel | null
  read: ReadCardModel | null
  search: SearchCardModel | null
  web: WebCardModelProps | null
  /** Flattened result text for the OUT section (generic / terminal). */
  output: string | null
  /** Original args JSON for the IN section (generic path only). */
  bodyRaw: string | null
  /** First line of an error result; replaces the collapsed summary. */
  errorSummary: string | null
}

/** Flatten a generic/terminal result view to the text ToolRow's OUT section
 *  renders. Diff / read / search carry structured cards instead and return ''. */
function flattenResultText(view: ToolResultView): string {
  switch (view.card) {
    case 'generic': {
      const block = view.content?.[0]
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return String((block as { text?: string }).text ?? '')
      }
      return ''
    }
    case 'terminal':
      return view.output ?? ''
    default:
      return ''
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Serialize the args object back to the JSON string ToolRow's
 *  `formatToolBody` re-parses & pretty-prints for the expanded IN section. */
function argsBodyRaw(args: unknown): string | null {
  if (args === undefined || args === null) return null
  if (typeof args === 'string') return args === '' ? null : args
  try {
    return JSON.stringify(args)
  } catch {
    return null
  }
}

function toCardModels(view: ToolResultView, args: unknown, ok: boolean, web: WebCardModelProps | null): CardModels {
  if (web !== null) {
    return { diff: null, read: null, search: null, web, output: null, bodyRaw: null, errorSummary: null }
  }
  switch (view.card) {
    case 'diff':
      return { diff: { card: { diffs: view.diffs } }, read: null, search: null, web: null, output: null, bodyRaw: null, errorSummary: null }
    case 'read':
      return {
        diff: null,
        read: { label: view.path, lines: view.lines, totalLines: view.totalLines, lang: view.lang },
        search: null,
        web: null,
        output: null,
        bodyRaw: null,
        errorSummary: null,
      }
    case 'search':
      return {
        diff: null,
        read: null,
        search: view.shape === 'matches'
          ? { card: { kind: 'matches', files: view.files, total: view.total, truncated: view.truncated }, recovery: undefined }
          : { card: { kind: 'paths', paths: view.paths, total: view.total, truncated: view.truncated }, recovery: undefined },
        web: null,
        output: null,
        bodyRaw: null,
        errorSummary: null,
      }
    // 'generic' / 'terminal' / 'web' fall through to the input/output body.
    default: {
      const text = flattenResultText(view)
      return {
        diff: null,
        read: null,
        search: null,
        web: null,
        output: text === '' ? null : text,
        bodyRaw: argsBodyRaw(args),
        errorSummary: ok ? null : firstLine(text),
      }
    }
  }
}

/** One-line preview of the call's args for the collapsed summary. Never enters
 *  the body — pure first-line projection, no JSON pretty-print of the whole
 *  payload. Tailored to our domain: a `title` / `id` arg wins outright so
 *  `todo.create({title})` summarizes as the task title. */
function summarizeArgs(args: unknown, fallback: string): string {
  let raw: unknown = args
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = args
    }
  }
  if (typeof raw === 'string') return raw.split('\n')[0] ?? ''
  if (Array.isArray(raw)) {
    const texts = raw
      .map((b) =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join('').split('\n')[0] ?? ''
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>
    const title = typeof obj['title'] === 'string' ? obj['title'] : undefined
    const id = typeof obj['id'] === 'string' ? obj['id'] : undefined
    if (title) return title
    if (id) return id
    try {
      const flat = JSON.stringify(raw)
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
    } catch {
      return fallback
    }
  }
  return fallback
}

export const DomainToolRow: React.FC<{
  toolName: string
  args: unknown
  result: unknown
  presentationMeta?: unknown
  ok: boolean
  running: boolean
}> = ({ toolName, args, result, presentationMeta, ok, running }) => {
  const callView = useMemo(() => presentToolCall(toolName, args), [toolName, args])
  const resultView = useMemo(
    () => presentToolResult(toolName, args, result, ok),
    [toolName, args, result, ok],
  )
  // Stop state: the runtime's cancel path marks the result with a
  // 'cancelled:'-prefixed string. DSH uses 'warning' amber for stops; we map
  // it onto ToolRow's `stopped` state so an interrupted call is distinguishable
  // from a successful one (amber dot) and a failed one (red dot).
  const stopped = ok === false && typeof result === 'string' && result.startsWith('cancelled:')
  const state: ToolRowState = running ? 'running' : stopped ? 'stopped' : ok ? 'ok' : 'error'
  // presentToolCall always returns a GenericCallView (card:'generic' + kind),
  // but its declared return type is the full ToolCallView union, where `kind`
  // lives only on the generic arm — narrow before indexing variantByKind.
  const variant = toolName === 'web_search' || toolName === 'web_fetch'
    ? classifyTool(toolName)
    : callView.card === 'generic'
      ? variantByKind[callView.kind ?? 'other']
      : 'others'
  const web = useMemo(
    () => webCardModelFromMeta(toolName, args, presentationMeta, !ok),
    [toolName, args, presentationMeta, ok],
  )
  const cards = useMemo(() => toCardModels(resultView, args, ok, web), [resultView, args, ok, web])
  const summary = useMemo(() => summarizeArgs(args, toolName), [args, toolName])
  const title = resultView.title ?? callView.title ?? toolName
  return (
    <ToolRow
      t={t}
      variant={variant}
      toolName={toolName}
      icon={VARIANT_ICONS[variant]}
      title={title}
      summary={summary}
      state={state}
      diff={cards.diff}
      read={cards.read}
      search={cards.search}
      web={cards.web}
      bodyRaw={cards.bodyRaw}
      output={cards.output}
      errorSummary={cards.errorSummary}
    />
  )
}
