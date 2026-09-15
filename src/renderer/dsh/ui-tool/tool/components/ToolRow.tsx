import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, DiffBlock, DisclosureRow, IconInspectOutline12, JsonTree, ReadBlock, SearchBlock, StateDot, TerminalBlock, WebBlock,
  diffTotals,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenFileOptions } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from '../models/diff-card-model'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from '../models/read-card-model'
import type { ImageCardModel } from '../models/image-card-model'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from '../models/search-card-model'
import {
  localizeTerminalCardModel, terminalBlockLabels, type TerminalCardModel,
} from '../models/terminal-card-model'
import {
  diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels,
} from '../models/primitive-labels'
import type { AskQuestionCardModel } from '../models/ask-question-card-model'
import {
  formatToolBody, type ToolRowState, type ToolRowVariant,
} from '../models/tool-call-model'
import type { WebCardModelProps } from '../models/web-card-model'
import { AskQuestionCard } from './AskQuestionCard'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  t: TranslateNS<'conversation'>
  variant: ToolRowVariant
  /** Wire tool name for tool-owned styling layered over the generic variant. */
  toolName?: string | undefined
  icon: ReactNode
  title: string
  summary: string
  /**
   * Trailing summary fragment rendered outside the ellipsized summary text, so
   * a narrow row clips the summary before this. For a fragment whose whole
   * value is surviving that clip — the todo row's parallel-active count.
   * null/absent = the summary is the whole collapsed content. Dropped on an
   * error row, whose collapsed summary is the failure line instead.
   */
  summarySuffix?: string | null | undefined
  /** Original argument JSON formatted only while the row is expanded. */
  bodyRaw?: string | null | undefined
  /**
   * When true AND a structured card is also rendered, force the input section
   * to be shown ABOVE the card (instead of suppressed). Diff / read / search /
   * web / terminal all set bodyRaw=null by default because the card carries
   * the same info — but our callers want the raw args visible regardless of
   * card type so the user can distinguish "{} = 无参数" from
   * "argsKnown=false = 未记录输入". Generic / code paths leave this off: the
   * IO card's own input section below would otherwise double up.
   */
  showInputWithCard?: boolean | undefined
  /**
   * When `showInputWithCard` is on AND `bodyRaw` is null (no tool/call event
   * arrived — only the result), render this hint string in the input section
   * instead. Default: the row's `bodyRaw=null` input section just disappears.
   * The caller passes "未记录输入" (or its translation) for missing-call rows.
   */
  missingInputHint?: string | null | undefined
  /** Flattened result text for the expanded Output section; null/absent = no output section. */
  output?: string | null | undefined
  /** Ask-user transcript card; card fields are mutually exclusive and replace text sections. */
  askQuestion?: AskQuestionCardModel | null | undefined
  /** Error first line shown as the collapsed summary on an error row; null/absent = keep `summary`. */
  errorSummary?: string | null | undefined
  /** Terminal card; card fields are mutually exclusive and replace text sections. */
  terminal?: TerminalCardModel | null | undefined
  diff?: DiffCardModel | null | undefined
  read?: ReadCardModel | null | undefined
  /**
   * Image-card material for a call whose result is an image (derived by
   * `imageCardModel`). Rendered through the `tool.call.images` slot, so the
   * tool layer never imports an attachment implementation nor handles URL
   * authorization.
   */
  image?: ImageCardModel | null | undefined
  /**
   * Dispatch the image gallery through the tool-owned `tool.call.images`
   * slot, supplied by the toolview that owns this row together with the
   * session-authorized loader.
   */
  renderSlot?: PropsRenderSlots<'tool.call.images'>['renderSlot'] | undefined
  /** Session-authorized image URL loader for the gallery slot. */
  loadImage?: MessageImageLoader | undefined
  search?: SearchCardModel | null | undefined
  web?: WebCardModelProps | null | undefined
  state: ToolRowState
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** 1-based line the call was about; absent = open the file at its beginning. */
  filePathLine?: number | undefined
  /** Open the path (already cwd-resolved), landing on `filePathLine` when given. */
  onOpenFile?: ((path: string, options?: OpenFileOptions) => void) | undefined
  /**
   * Jump to this call in the trajectory view: a hover-revealed Inspect pill
   * over the expanded body. Absent = no affordance.
   */
  inspect?: (() => void) | undefined
  /** Raw wire tool name (e.g. "todo_planForToday"), shown as a small muted
   *  caption at the top of the expanded body so the friendly collapsed title
   *  can stay clean without losing the identity for debugging. */
  wireName?: string | undefined
}

/** Best-effort JSON parse for the IO card's "JSON" view. Returns null for
 *  non-JSON payloads (terminal output, error strings, multi-block joins) so
 *  the section falls back to plain text instead of forcing a broken tree. */
function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^[[{"]/.test(trimmed) && !/^(true|false|null|-?\d)/.test(trimmed)) return null
  try { return JSON.parse(trimmed) } catch { return null }
}

/** Chinese copy labels for the JsonTree's copy menu. Hardcoded because the
 *  `conversation` namespace has no JsonTree copy keys (the package is
 *  cordis-free; copy arrives via props). Module-level for reference stability. */
const JSON_TREE_LABELS: JsonTreeLabels = {
  copyValue: '复制值',
  copyJson: '复制 JSON',
  copyPath: '复制路径',
  copyPrettyJson: '复制格式化 JSON',
  copyCompactJson: '复制紧凑 JSON',
  copied: '已复制',
  copyFailed: '复制失败',
  collapseNode: '折叠',
  expandNode: '展开',
  copyButtonTitle: (action: string) => action,
}

/** Render one IO section (input or output). The gutter label ("输入"/"输出")
 *  and the grid layout are CONSTANT across views — only the content cell
 *  swaps: a structured JsonTree when the payload is parseable JSON + JSON view
 *  is on, otherwise the plain text span. Keeping the label in place means
 *  switching views doesn't move or restyle the input/output headers. */
function IoPayload({
  label,
  text,
  jsonView,
  error,
}: {
  label: string
  text: string
  jsonView: boolean
  error?: boolean
}) {
  const parsed = jsonView ? tryParseJson(text) : null
  const useTree = parsed !== null && typeof parsed === 'object'
  return (
    <div className={css.ioSection}>
      <span className={css.ioLabel}>{label}</span>
      {useTree ? (
        <div className={css.ioJson}>
          <JsonTree
            data={parsed as object}
            label={label}
            expandTopLevel
            labels={JSON_TREE_LABELS}
          />
        </div>
      ) : (
        <span className={css.ioText} data-error={error || undefined}>{text}</span>
      )}
    </div>
  )
}

function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

/** Visually hidden run-state label: the StateDot and the CSS sweep are both
 *  aria-hidden / colour-only, so assistive technology needs this text to know a
 *  row is running, failed, or interrupted. null in the ok state (the icon and
 *  summary already describe a settled row). */
function stateStatus(state: ToolRowState, t: TranslateNS<'conversation'>): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

export function ToolRow({
  t,
  variant,
  toolName,
  icon,
  title,
  summary,
  summarySuffix,
  bodyRaw,
  showInputWithCard,
  missingInputHint,
  output,
  askQuestion,
  errorSummary,
  terminal,
  diff,
  read,
  image,
  renderSlot,
  loadImage,
  search,
  web,
  state,
  filePath,
  filePathLine,
  onOpenFile,
  inspect,
  wireName,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  // JSON tree vs plain-text view for the IO card's input/output payloads. JSON
  // is the default (both sides are JSON for our domain tools); the user can
  // drop to plain text when a payload isn't JSON or they want the raw string.
  const [jsonView, setJsonView] = useState(true)
  const terminalLabels = useMemo(() => terminalBlockLabels(t), [t])
  const diffLabels = useMemo(() => diffBlockLabels(t), [t])
  const readLabels = useMemo(() => readBlockLabels(t), [t])
  const searchLabels = useMemo(() => searchBlockLabels(t), [t])
  const webLabels = useMemo(() => webBlockLabels(t), [t])
  const terminalBody = terminal === undefined || terminal === null
    ? null
    : localizeTerminalCardModel(terminal, t)
  const diffBody = diff ?? null
  const readBody = read ?? null
  const imageBody = image !== undefined && image !== null && renderSlot !== undefined && loadImage !== undefined
    ? image
    : null
  const searchBody = search ?? null
  const webBody = web ?? null
  const askQuestionBody = askQuestion ?? null
  const outputText = output ?? null
  const card = askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody
  // The header input section is reachable in two ways:
  //   1. `bodyRaw != null` — we know the args and can render them.
  //   2. `missingInputHint != null` — the caller saw only a tool/result and
  //      tells us to surface "未记录输入" so the user can tell the difference
  //      from "args = {}".
  // Both also make the row expandable (otherwise the section would never
  // show up and the toggle would feel dead).
  const expandable = bodyRaw != null || outputText !== null || card !== null || missingInputHint != null
  const open = expanded && expandable
  const bodyText = useMemo(
    () => open && card === null && bodyRaw != null ? formatToolBody(variant, bodyRaw) : null,
    [bodyRaw, card, open, variant],
  )
  const status = stateStatus(state, t)
  // A failure must replace, not supplement, the normal summary.
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const summaryText = failureLine ?? terminalBody?.description ?? summary
  // A diff row's collapsed line carries the card's +/- totals (the same
  // numbers the expanded footer prints) so the change size reads without
  // expanding; an explicit summarySuffix (none today on diff rows) wins.
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  const suffix = failureLine === null ? summarySuffix ?? diffStat : null
  const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath === undefined || onOpenFile === undefined) return
    if (filePathLine === undefined) onOpenFile(filePath)
    else onOpenFile(filePath, { line: filePathLine })
  }
  // Keep Enter/Space on the focused path link from bubbling to the row's
  // keydown handler, which would preventDefault() the key and toggle expand
  // instead of activating the link — the keyboard analogue of openFile's
  // stopPropagation. The native button still fires its own onClick from the key.
  const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  // The code variant's program renders through CodeBlock (shiki), so only its
  // output joins the IN/OUT card; every other variant's input does too.
  // When showInputWithCard is on, the header input section already rendered
  // the raw args above the structured card — suppress cardBody so the IO
  // card's own input section does not double up.
  const cardBody = (showInputWithCard === true && card !== null)
    ? null
    : variant === 'code' ? null : bodyText
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggleExpand}
        collapsedContent={summaryText !== '' && (
          /* An empty summary drops the separator with it (a row that is only
             its title shows no trailing dot). */
          <>
            <span className={css.sep} aria-hidden />
            {fileLink ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
                onKeyDown={fileLinkKeyDown}
              >
                {summaryText}
              </button>
            ) : (
              <span
                className={clsx(css.summary, failureLine !== null && css.errorSummary)}
              >
                {summaryText}
              </span>
            )}
            {suffix !== null && (
              <span className={clsx(css.summarySuffix, suffix === diffStat && css.diffStat)}>{suffix}</span>
            )}
          </>
        )}
      >
        <div className={css.bodyWrap}>
          {wireName && (
            <div className={css.wireName}>{wireName}</div>
          )}
          {/* Header input section — only when showInputWithCard is on AND a
              structured card is also being rendered. Rendered BEFORE the card
              so the card's own input section (in the IO card path) doesn't
              double up. The wrapper is scrollable (`.bodyScroll` caps height)
              so a giant args payload doesn't push the result off-screen; the
              row's title sits outside this wrapper in DisclosureRow and
              stays visible while the user scrolls the args.
              Generic / code paths skip this — their IO card already has the
              input section below. */}
          {showInputWithCard === true && card !== null && (bodyRaw != null || missingInputHint != null) && (
            <div className={css.bodyScroll}>
              <div className={css.ioCard}>
                <div className={css.ioSection}>
                  <span className={css.ioLabel}>{t('row.input')}</span>
                  <span className={css.ioText}>
                    {bodyRaw != null ? formatToolBody(variant, bodyRaw) : missingInputHint}
                  </span>
                </div>
              </div>
            </div>
          )}
          {askQuestionBody !== null
            ? <AskQuestionCard card={askQuestionBody} />
            : terminalBody !== null
              ? (
                <TerminalBlock
                  {...terminalBody.card}
                  maxLines={Infinity}
                  labels={terminalLabels}
                  className={css.terminalBody}
                />
              )
              : diffBody !== null
                ? <DiffBlock {...diffBody.card} labels={diffLabels} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
                : readBody !== null
                  ? <ReadBlock {...readBody} labels={readLabels} maxLines={CHAT_READ_MAX_LINES} className={css.readBody} />
                  : imageBody !== null
                    ? (
                      /* Label, gallery, then the result's OWN envelope text. The text
                         comes from the image card model (which reads the result's text
                         block), never from the row's flattened output: an image read's
                         content is [text envelope, image block] and flattening
                         JSON.stringifies the image block, printing the raw attachment
                         object under the picture. It is not redundant either — the
                         attachment slot can render nothing, and then this line is the
                         only evidence an image was returned. */
                      <div className={css.imageBody}>
                        <div className={css.imageLabel}>{imageBody.label}</div>
                        {renderSlot !== undefined && loadImage !== undefined && renderSlot('tool.call.images', {
                          images: imageBody.images,
                          loadImage,
                          align: 'start',
                        })}
                        <div className={css.imageMeta}>{imageBody.text}</div>
                      </div>
                    )
                    : searchBody !== null
                      ? (
                        <>
                          <SearchBlock
                            {...searchBody.card}
                            labels={searchLabels}
                            maxLines={CHAT_SEARCH_MAX_LINES}
                            className={css.searchBody}
                          />
                          {/* A capped search's recovery locator lives only in the result
                          text; show it below the card so the dropped rows survive. */}
                          {searchBody.recovery !== undefined && (
                            <div className={css.searchRecovery}>{searchBody.recovery}</div>
                          )}
                        </>
                      )
                      : webBody !== null
                        ? <WebBlock {...webBody} labels={webLabels} className={css.webBody} />
                        : (
                          <>
                            {variant === 'code' && bodyText !== null && (
                              <div className={css.bodyScroll}>
                                <CodeBlock code={bodyText} lang="typescript" copyLabel={t('copy')} copiedLabel={t('copied')} className={css.codeBody} />
                              </div>
                            )}
                            {(cardBody !== null || outputText !== null) && (
                              <div className={css.ioCard}>
                                <div className={css.ioToolbar} role="group" aria-label="视图切换">
                                  <button
                                    type="button"
                                    className={clsx(css.ioToggleBtn, jsonView && css.ioToggleBtnActive)}
                                    onClick={() => setJsonView(true)}
                                    aria-pressed={jsonView}
                                  >JSON</button>
                                  <button
                                    type="button"
                                    className={clsx(css.ioToggleBtn, !jsonView && css.ioToggleBtnActive)}
                                    onClick={() => setJsonView(false)}
                                    aria-pressed={!jsonView}
                                  >纯文本</button>
                                </div>
                                {cardBody !== null && (
                                  <IoPayload
                                    label={t('row.input')}
                                    text={cardBody}
                                    jsonView={jsonView}
                                  />
                                )}
                                {cardBody !== null && outputText !== null && (
                                  <span className={css.ioDivider} aria-hidden />
                                )}
                                {outputText !== null && (
                                  <IoPayload
                                    label={t('row.output')}
                                    text={outputText}
                                    jsonView={jsonView}
                                    error={state === 'error'}
                                  />
                                )}
                              </div>
                            )}
                          </>
                        )}
          {inspect !== undefined && (
            <button
              type="button"
              className={css.inspectButton}
              onClick={inspect}
            >
              <IconInspectOutline12 />
              {t('row.inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
