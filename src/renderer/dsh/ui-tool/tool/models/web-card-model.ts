/** Pure web-card derivation from raw web result metadata. @module */
import type { WebBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model'
import { parsedToolCall } from './raw-tool-call'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** Web-card data owned by the presenter; render sites add localized labels and classes. */
export type WebCardModelProps = DistributiveOmit<WebBlockProps, 'labels' | 'className'>

/** Derive the DSH WebBlock model directly from the durable tool/result meta.
 * Host adapters that already pair call + result can use this without first
 * recreating the conversation package's full ToolCallBlock node. */
export function webCardModelFromMeta(
  toolName: string,
  args: unknown,
  meta: unknown,
  isError = false,
  parentCallId?: string,
): WebCardModelProps | null {
  if (parentCallId !== undefined || isError) return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const callArgs = args as Record<string, unknown>
  const resultMeta = meta as Record<string, unknown>
  if (typeof resultMeta.truncated !== 'boolean') return null
  if (toolName === 'web_search') {
    const queries = callArgs.queries
    if (!Array.isArray(queries) || queries.length === 0 || !queries.every(query => typeof query === 'string' && query.trim() !== '')) return null
    const sources = webSources(resultMeta.sources)
    if (sources === null || (resultMeta.answer !== undefined && typeof resultMeta.answer !== 'string')) return null
    return {
      kind: 'search',
      sources,
      truncated: resultMeta.truncated,
      ...(resultMeta.answer === undefined ? {} : { answer: resultMeta.answer as string }),
    }
  }
  if (toolName !== 'web_fetch') return null
  if (typeof callArgs.url !== 'string' || callArgs.url.trim() === '') return null
  if (typeof resultMeta.url !== 'string') return null
  if (typeof resultMeta.statusCode !== 'number' || !Number.isInteger(resultMeta.statusCode)) return null
  return {
    kind: 'fetch',
    url: resultMeta.url,
    statusCode: resultMeta.statusCode,
    truncated: resultMeta.truncated,
  }
}

function validWebCall(block: ToolCallBlock): 'web_search' | 'web_fetch' | null {
  const call = parsedToolCall(block)
  if (call === null) return null
  if (call.name === 'web_search') {
    const { queries } = call.args
    if (!Array.isArray(queries) || queries.length === 0) return null
    return queries.every(query => typeof query === 'string' && query.trim() !== '') ? call.name : null
  }
  if (call.name === 'web_fetch') {
    const { url } = call.args
    return typeof url === 'string' && url.trim() !== '' ? call.name : null
  }
  return null
}

interface WebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

function webSources(value: unknown): WebSource[] | null {
  if (!Array.isArray(value)) return null
  const sources: WebSource[] = []
  for (const source of value) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
    const { url, title, snippet, publishedAt } = source as Record<string, unknown>
    if (typeof url !== 'string') return null
    if (title !== undefined && typeof title !== 'string') return null
    if (snippet !== undefined && typeof snippet !== 'string') return null
    if (publishedAt !== undefined && typeof publishedAt !== 'string') return null
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  return sources
}

/**
 * Derive a settled root web-search or web-fetch card from persisted metadata.
 * @param block - running or settled Tool block.
 * @returns web-card props, or null for the generic path.
 */
export function webCardModel(block: ToolCallBlock): WebCardModelProps | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  const tool = validWebCall(block)
  if (tool === null) return null
  const call = parsedToolCall(block)
  if (call === null) return null
  return webCardModelFromMeta(tool, call.args, block.meta, block.isError, block.parentCallId)
}
