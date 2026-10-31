export interface AIExecutionSnapshot {
  revision: number;
  agentRunning?: boolean;
  invocations: Array<{ invocationId: string; startedAt: number; phase: 'running' | 'stopping' }>;
  jobs?: Array<{ id: string; kind: string; status: string }>;
}
