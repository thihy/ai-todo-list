import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { Automation, AutomationInput, AutomationRun, AutomationSnapshot } from '../../shared/automation-types';

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error('调度数字超出有效范围');
  return value as number;
}

export function scheduleExpression(input: AutomationInput): string {
  const schedule = input.schedule;
  if (schedule.kind === 'cron') {
    if (typeof schedule.expression !== 'string' || schedule.expression.length > 200 || schedule.expression.trim().split(/\s+/).length !== 5) throw new Error('Cron 必须包含五个字段：分 时 日 月 周');
    return schedule.expression.trim();
  }
  if (schedule.kind !== 'calendar' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('周期时间无效');
  const [hour, minute] = schedule.time.split(':').map(Number);
  if (schedule.frequency === 'daily') return `${minute} ${hour} * * *`;
  if (schedule.frequency === 'weekly') return `${minute} ${hour} * * ${integer(schedule.day, 0, 6)}`;
  if (schedule.frequency === 'monthly') return `${minute} ${hour} ${integer(schedule.day, 1, 31)} * *`;
  throw new Error('周期类型无效');
}

export function nextRun(input: AutomationInput, after: number, anchor = after): number {
  if (input.schedule.kind === 'interval') {
    const duration = integer(input.schedule.minutes, 1, 525600) * 60000;
    return anchor + Math.max(1, Math.floor((after - anchor) / duration) + 1) * duration;
  }
  return CronExpressionParser.parse(scheduleExpression(input), { currentDate: after, tz: input.timezone }).next().getTime();
}

export function validateAutomation(raw: AutomationInput, now: number): AutomationInput {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 ||
      typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 100000 ||
      typeof raw.enabled !== 'boolean' || typeof raw.timezone !== 'string' || !raw.timezone.trim() || !raw.schedule) throw new Error('自动化名称、指令或调度参数无效');
  new Intl.DateTimeFormat('en', { timeZone: raw.timezone }).format(now);
  const input = structuredClone({ name: raw.name.trim(), prompt: raw.prompt.trim(), timezone: raw.timezone, enabled: raw.enabled, schedule: raw.schedule });
  nextRun(input, now);
  return input;
}

export interface ExecutionResult { conversationId: string; content: string }

export class AutomationScheduler {
  private state: AutomationSnapshot = { automations: [], runs: [] };
  private timer?: NodeJS.Timeout;
  private active = new Set<string>();
  private stopped = false;

  constructor(private readonly path: string, private readonly execute: (automation: Automation, reportConversation: (id: string) => void) => Promise<ExecutionResult>,
    private readonly ready: () => boolean, private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly onChanged: () => void = () => {}) {
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as AutomationSnapshot;
      if (!Array.isArray(saved.automations) || !Array.isArray(saved.runs)) throw new Error('自动化数据格式无效');
      const now = this.now();
      this.state.automations = saved.automations.map((item) => {
        const input = validateAutomation(item, now);
        if (typeof item.id !== 'string' || !Number.isFinite(item.createdAt)) throw new Error('自动化记录无效');
        return { ...input, id: item.id, createdAt: item.createdAt, nextRunAt: input.enabled ? nextRun(input, now, item.createdAt) : null };
      });
      this.state.runs = saved.runs.slice(-200).map((run) => run.status === 'running' ? { ...run, status: 'interrupted', finishedAt: now, result: '应用关闭，执行已中断，未自动重试。' } : run);
      this.persist();
    }
  }

  snapshot(): AutomationSnapshot { return structuredClone(this.state); }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(temporary, this.path);
    // Notify only committed state. UI and DSH tools share this mutation boundary.
    try { this.onChanged(); } catch (error) { this.onError(error); }
  }

  save(input: AutomationInput, id?: string): Automation {
    const now = this.now();
    const valid = validateAutomation(input, now);
    const existing = id ? this.state.automations.find((item) => item.id === id) : undefined;
    if (id && !existing) throw new Error('自动化不存在');
    if (id && this.active.has(id)) throw new Error('请等待当前执行完成后再修改');
    const item: Automation = { ...valid, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now,
      nextRunAt: valid.enabled ? nextRun(valid, now, existing?.createdAt ?? now) : null };
    const previous = this.state.automations;
    this.state.automations = [...previous.filter((row) => row.id !== item.id), item];
    try { this.persist(); } catch (error) { this.state.automations = previous; throw error; }
    return structuredClone(item);
  }

  remove(id: string): void {
    if (this.active.has(id)) throw new Error('请等待当前执行完成后再删除');
    const previous = this.state.automations;
    this.state.automations = previous.filter((item) => item.id !== id);
    try { this.persist(); } catch (error) { this.state.automations = previous; throw error; }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(this.onError); }, 15000);
  }

  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    if (this.stopped || !this.ready()) return;
    const now = this.now();
    for (const item of this.state.automations) {
      if (!item.enabled || item.nextRunAt === null || item.nextRunAt > now) continue;
      const missed = now - item.nextRunAt > 60000;
      // Consume the occurrence even when the previous run is still active.
      item.nextRunAt = nextRun(item, now, item.createdAt);
      this.persist();
      if (!missed && !this.active.has(item.id)) void this.run(item.id).catch(this.onError);
    }
  }

  async run(id: string): Promise<void> {
    if (this.stopped || !this.ready()) throw new Error('AI 尚未就绪，请先在设置中配置模型并等待启动完成');
    if (this.active.has(id)) throw new Error('该自动化正在执行');
    const item = this.state.automations.find((row) => row.id === id);
    if (!item) throw new Error('自动化不存在');
    const run: AutomationRun = { id: randomUUID(), automationId: id, name: item.name, startedAt: this.now(), status: 'running' };
    this.active.add(id);
    this.state.runs.push(run);
    // Keep every active run even if the history limit is reached.
    this.state.runs = this.state.runs.filter((entry, index, all) => entry.status === 'running' || index >= all.length - 200);
    try {
      this.persist();
      const result = await this.execute(structuredClone(item), (conversationId) => { run.conversationId = conversationId; this.persist(); });
      run.conversationId = result.conversationId;
      run.result = result.content.slice(0, 20000);
      run.status = 'succeeded';
    } catch (error) {
      run.status = 'failed';
      run.result = error instanceof Error ? error.message : String(error);
    } finally {
      run.finishedAt = this.now();
      this.active.delete(id);
      this.persist();
    }
  }
}
