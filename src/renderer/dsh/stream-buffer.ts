import type { AIStreamEvent } from '../../shared/ai-types';

/**
 * Keep every event for the invocation currently being rendered, while
 * bounding leftover events from older invocations. The previous global
 * `slice(-200)` could cut the beginning off a long active answer.
 */
export function compactAiStreamEvents(
  events: AIStreamEvent[],
  activeInvocationId: string,
  historicalLimit = 200,
): AIStreamEvent[] {
  let historicalCount = 0;
  for (const event of events) {
    if (event.invocationId !== activeInvocationId) historicalCount += 1;
  }
  if (historicalCount <= historicalLimit) return events;

  let toDrop = historicalCount - historicalLimit;
  return events.filter((event) => {
    if (event.invocationId === activeInvocationId || toDrop === 0) return true;
    toDrop -= 1;
    return false;
  });
}
