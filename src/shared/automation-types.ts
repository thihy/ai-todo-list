export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'calendar'; frequency: 'daily' | 'weekly' | 'monthly'; time: string; day?: number }
  | { kind: 'cron'; expression: string };

export interface AutomationInput {
  name: string;
  prompt: string;
  timezone: string;
  schedule: AutomationSchedule;
  enabled: boolean;
}

export interface Automation extends AutomationInput {
  id: string;
  createdAt: number;
  nextRunAt: number | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  name: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  conversationId?: string;
  result?: string;
}

export interface AutomationSnapshot {
  automations: Automation[];
  runs: AutomationRun[];
}
