export interface BackgroundJob {
  id: string; kind: string; status: string; ownerSession?: string;
}
export interface BackgroundJobService {
  list(caller: unknown): BackgroundJob[];
  kill(id: string, caller: unknown): unknown;
  wait(id: string, timeoutMs: number, caller: unknown): Promise<{ status: string }>;
}
export function ownedBackgroundJobs(service: BackgroundJobService | undefined, owner: unknown, conversationId: string): BackgroundJob[] {
  return !service || !owner ? [] : service.list(owner).filter(job => job.ownerSession === conversationId);
}
export async function stopBackgroundJobs(service: BackgroundJobService | undefined, owner: unknown, conversationId: string): Promise<void> {
  const live = ownedBackgroundJobs(service, owner, conversationId).filter(job => ['running', 'stopping'].includes(job.status));
  if (!service || !live.length) return;
  for (const job of live) service.kill(job.id, owner);
  const settled = await Promise.all(live.map(job => service.wait(job.id, 5000, owner)));
  if (settled.some(job => ['running', 'stopping'].includes(job.status))) throw new Error('后台任务仍在停止，请等待实际执行状态更新');
}
