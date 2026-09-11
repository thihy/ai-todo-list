/** rAF-throttled wrapper over the vendored DSH `ReasoningRow`.
 *
 *  DSH's ReasoningRow assumes a reactive session store that batches token
 *  deltas before they reach the row. Our `useAiStream` delivers coalesced-but-
 *  unbatched updates (one event per reasoning run, growing on each delta), so
 *  without a rAF gate a long thinking burst would reflow once per delta. We
 *  pass the throttled snapshot while running and the final text once settled;
 *  the summary (latest line while running, first line settled) and body both
 *  read from the same value. */
import React from 'react'
import { ReasoningRow } from './ui-chat/chat/ReasoningRow'
import { useThrottledVisualUpdate } from '../hooks/useThrottledVisualUpdate'
import { conversationT as t } from './conversation-locale'

export const DomainReasoningRow: React.FC<{ text: string; running: boolean }> = ({ text, running }) => {
  const throttled = useThrottledVisualUpdate(text)
  return <ReasoningRow text={running ? throttled : text} running={running} t={t} />
}
