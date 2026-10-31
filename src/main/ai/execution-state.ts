import type { AIExecutionSnapshot } from '../../shared/ai-execution';

/** Main owns execution lifetime; renderer completion and plan progress do not. */
export class AIExecutionRegistry {
  private revision = 0;
  private conversations = new Map<string, Map<string, AIExecutionSnapshot['invocations'][number]>>();
  begin(conversationId: string, invocationId: string): () => void {
    const entries = this.conversations.get(conversationId) ?? new Map();
    entries.set(invocationId, { invocationId, startedAt: Date.now(), phase: 'running' });
    this.conversations.set(conversationId, entries); this.revision++;
    return () => {
      if (!entries.delete(invocationId)) return;
      if (!entries.size) this.conversations.delete(conversationId);
      this.revision++;
    };
  }
  stopping(conversationId: string): void {
    for (const entry of this.conversations.get(conversationId)?.values() ?? []) entry.phase = 'stopping';
    this.revision++;
  }
  snapshot(conversationId: string): AIExecutionSnapshot {
    return { revision: this.revision, invocations: [...(this.conversations.get(conversationId)?.values() ?? [])].map(entry => ({ ...entry })) };
  }
}
