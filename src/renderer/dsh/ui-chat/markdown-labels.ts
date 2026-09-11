/** Localized copy adapters for Cordis-free Markdown primitives.
 *
 *  Vendored verbatim from deepseek-harness
 *  packages/client/ui-chat/src/client/markdown-labels.ts (0.1.5-rc.2).
 *  Only the `.ts` import extension on the local slots shim was dropped.
 *  The real file's `./contract/slots.ts` import is satisfied by our local
 *  re-export shim (../../contract/slots) which forwards `ChatViewSlotProps`
 *  from the installed ui-chat client package. */

import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from './contract/slots'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}
