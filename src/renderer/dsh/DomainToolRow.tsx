/** Adapter: map our `(toolName, args, argsKnown, result, resultKnown, ok, state)`
 *  presentation vocabulary onto the vendored DSH `ToolRow`'s `*CardModel` props.
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
 *  Tool identity (title + name) is preserved end-to-end:
 *  - Title = `<callTitle> · <toolName>` (e.g. "读取正文 · content.readBody"),
 *    so even a "diff" or "read" result whose card title is "正文" / "版本历史"
 *    can't overwrite the call identity.
 *  - Args serialisation is independent of card type: every branch passes
 *    the raw args body through so the user always sees the input section
 *    (and can distinguish "{} = 无参数" from "argsKnown=false = 未记录输入").
 */
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
  /** Original args JSON for the IN section. Populated for ALL branches
   *  (was previously nulled for diff/read/search/web — see fix below). */
  bodyRaw: string | null
  /** First line of an error result; replaces the collapsed summary. */
  errorSummary: string | null
}

/** Flatten a generic/terminal result view to the text ToolRow's OUT section
 *  renders. Diff / read / search carry structured cards instead and return ''.
 *
 *  Fix vs prior: process ALL text blocks in the content array (not just [0])
 *  and surface non-text blocks as explicit `[type 内容]` hints instead of
 *  silently dropping them or producing "[object Object]". Tools that produce
 *  multiple text blocks (rare but possible) are joined with blank lines so
 *  each block reads distinctly. */
function flattenResultText(view: ToolResultView): string {
  switch (view.card) {
    case 'generic': {
      const blocks = view.content ?? [];
      const parts: string[] = [];
      for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: string }).text;
          if (typeof text === 'string' && text.length > 0) parts.push(text);
        } else if (block && typeof block === 'object') {
          const blockType = (block as { type?: string }).type ?? '未知';
          parts.push(`[${blockType} 内容]`);
        }
      }
      return parts.join('\n\n');
    }
    case 'terminal':
      return view.output ?? '';
    default:
      return '';
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Serialize the args object back to the JSON string ToolRow's
 *  `formatToolBody` re-parses & pretty-prints for the expanded IN section.
 *  Returns:
 *    - the JSON string when args are known (even if empty {}),
 *    - `null` when argsKnown is false (caller decides what to display),
 *    - `null` only as a defensive fallback on unserialisable inputs.
 *  Note: "{}" is a valid (empty-args) payload and is returned as-is. Do
 *  NOT collapse it to null — that would erase the distinction from
 *  "未记录输入". */
function argsBodyRaw(args: unknown, argsKnown: boolean): string | null {
  if (!argsKnown) return null;
  if (args === undefined) return '{}';
  if (args === null) return 'null';
  if (typeof args === 'string') return args === '' ? '{}' : args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    try { return String(args); } catch { return null; }
  }
}

function toCardModels(
  view: ToolResultView,
  args: unknown,
  argsKnown: boolean,
  ok: boolean,
  web: WebCardModelProps | null,
): CardModels {
  // bodyRaw is independent of card type. Previously diff/read/search/web
  // each had explicit cases that set bodyRaw to null on the grounds that
  // "the card carries the same info" — but the card does NOT carry the raw
  // args; it carries the result side. The user reported the row showing
  // only the output, with no input section at all. Now: every branch gets a
  // populated bodyRaw (or null when args are unknown), and the caller
  // decides how to render the input.
  const bodyRaw = argsBodyRaw(args, argsKnown);
  if (web !== null) {
    return { diff: null, read: null, search: null, web, output: null, bodyRaw, errorSummary: null };
  }
  switch (view.card) {
    case 'diff':
      return { diff: { card: { diffs: view.diffs } }, read: null, search: null, web: null, output: null, bodyRaw, errorSummary: null };
    case 'read':
      return {
        diff: null,
        read: { label: view.path, lines: view.lines, totalLines: view.totalLines, lang: view.lang },
        search: null,
        web: null,
        output: null,
        bodyRaw,
        errorSummary: null,
      };
    case 'search':
      return {
        diff: null,
        read: null,
        search: view.shape === 'matches'
          ? { card: { kind: 'matches', files: view.files, total: view.total, truncated: view.truncated }, recovery: undefined }
          : { card: { kind: 'paths', paths: view.paths, total: view.total, truncated: view.truncated }, recovery: undefined },
        web: null,
        output: null,
        bodyRaw,
        errorSummary: null,
      };
    // 'generic' / 'terminal' / 'web' fall through to the input/output body.
    default: {
      const text = flattenResultText(view);
      return {
        diff: null,
        read: null,
        search: null,
        web: null,
        output: text === '' ? null : text,
        bodyRaw,
        errorSummary: ok ? null : firstLine(text),
      };
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
  argsKnown: boolean
  result: unknown
  /**
   * Whether the caller actually saw a tool/result event. False for
   * "missing-result" rows (turn ended before the result arrived) and any
   * orphan we couldn't pair. Not consumed here directly — present only
   * because the wire contract and several call sites pass it; the
   * presentation effect comes from the explicit `state` field below.
   */
  resultKnown?: boolean | undefined
  presentationMeta?: unknown
  ok: boolean
  /**
   * Explicit lifecycle from the projection layer. When present, this
   * drives the row state — we do NOT re-derive from `ok` / result-string
   * heuristics, because that would lose the "missing-call" / "missing-
   * result" / "stopped" distinctions the new contract is supposed to
   * surface.
   */
  state?: 'running' | 'done' | 'error' | 'stopped' | 'missing-call' | 'missing-result' | undefined
  /**
   * Caller's running hint — used only when `state` is absent (legacy call
   * sites that haven't migrated to the explicit lifecycle yet). When
   * `state` is provided it takes precedence.
   */
  running?: boolean | undefined
}> = ({ toolName, args, argsKnown, result, presentationMeta, ok, state, running }) => {
  const callView = useMemo(() => presentToolCall(toolName, args), [toolName, args])
  const resultView = useMemo(
    () => presentToolResult(toolName, args, result, ok),
    [toolName, args, result, ok],
  )
  // ToolRow state mapping. The explicit `state` from the projection is the
  // authoritative source — only fall back to the legacy heuristics when
  // it's absent (e.g. older call sites that haven't migrated). The
  // 'missing-call' / 'missing-result' states deliberately do NOT map to
  // an error: missing-result is "turn ended before result arrived" (not a
  // failure), missing-call is "result with no corresponding call" (also
  // not a user-visible error). They render via `ok`-based dot but with a
  // distinct summary via errorSummary in cards.
  let rowState: ToolRowState;
  if (state === 'error') rowState = 'error';
  else if (state === 'stopped') rowState = 'stopped';
  else if (state === 'running') rowState = 'running';
  else if (state === 'done') rowState = 'ok';
  else if (state === 'missing-call' || state === 'missing-result') {
    // Surface as ok — the renderer uses a dedicated errorSummary line to
    // tell the user the result was lost, not the red error dot. We still
    // keep `ok=false` on the wire so the visual treatment is neutral,
    // not "success-green".
    rowState = ok ? 'ok' : 'error';
  } else {
    // Legacy fallback (caller didn't provide explicit state):
    //   running → 'running'
    //   ok && cancelled prefix → 'stopped'
    //   ok → 'ok'
    //   else → 'error'
    const stopped = ok === false && typeof result === 'string' && result.startsWith('cancelled:');
    rowState = running ? 'running' : stopped ? 'stopped' : ok ? 'ok' : 'error';
  }
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
  const cards = useMemo(() => toCardModels(resultView, args, argsKnown, ok, web), [resultView, args, argsKnown, ok, web])
  const summary = useMemo(() => summarizeArgs(args, toolName), [args, toolName])
  // Tool IDENTITY is preserved here. The call title (`presentToolCall` →
  // titleFor) carries the human-readable label ("读取正文"); toolName is the
  // wire name ("content.readBody"). Combined: "读取正文 · content.readBody".
  // resultView.title (e.g. "正文", "版本历史") is intentionally NOT used as
  // identity — it describes the result, not the call. For missing-call
  // rows (argsKnown=false), identity falls back to the explicit fallback.
  const callTitle = callView.title ?? '';
  const title = !argsKnown
    ? '工具调用信息缺失'
    : (callTitle && toolName
        ? `${callTitle} · ${toolName}`
        : toolName || callTitle || '工具调用');
  // The header input section renders ABOVE the body when EITHER a
  // structured card carries it (so the user sees the raw args above the
  // diff/read/search/web card) OR we have a missing-call fallback to
  // surface ("未记录输入" — spec: "最终仅有结果时显示「工具调用信息缺失」
  // 和「未记录输入」"). Without this, an orphan result with no name
  // lands in the generic IO path with bodyRaw=null → no input section
  // rendered anywhere → the user sees only the output, exactly the bug
  // the spec is fixing.
  //
  // Generic / code paths with a real bodyRaw keep showInputWithCard off
  // because the IO card's own input section below would otherwise double
  // up. We only suppress cardBody when showInputWithCard AND card !== null
  // (ToolRow's behaviour); an orphan with no card still falls through to
  // the IO card, which itself shows no input because bodyRaw=null — and
  // the header input section has already shown "未记录输入".
  const hasStructuredCard =
    cards.diff !== null || cards.read !== null || cards.search !== null ||
    cards.web !== null || resultView.card === 'terminal';
  const showInputWithCard = hasStructuredCard || !argsKnown;
  return (
    <ToolRow
      t={t}
      variant={variant}
      toolName={toolName}
      icon={VARIANT_ICONS[variant]}
      title={title}
      summary={summary}
      state={rowState}
      diff={cards.diff}
      read={cards.read}
      search={cards.search}
      web={cards.web}
      bodyRaw={cards.bodyRaw}
      output={cards.output}
      errorSummary={cards.errorSummary}
      showInputWithCard={showInputWithCard}
      missingInputHint={argsKnown ? undefined : '未记录输入'}
    />
  )
}