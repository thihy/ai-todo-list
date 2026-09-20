/** DSH recovery and cancellation are not ordinary execution failures. */
export function toolInterruptionState(error: unknown): 'stopped' | 'missing-result' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: string; info?: { code?: string } };
  const code = value.code ?? value.info?.code;
  if (code === 'TOOL_OUTCOME_UNKNOWN') return 'missing-result';
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'stopped';
  return undefined;
}
