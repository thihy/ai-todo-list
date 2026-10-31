import { expect, it, vi } from 'vitest';
import { ownedBackgroundJobs, stopBackgroundJobs } from '../../src/main/dsh/background-jobs';
it('only observes and stops live jobs belonging to this conversation, awaiting real settlement', async () => {
  const owner = {};
  const jobs = { list: vi.fn(() => [
    { id: 'own', kind: 'pwsh', status: 'running', ownerSession: 'conv' },
    { id: 'done', kind: 'pwsh', status: 'completed', ownerSession: 'conv' },
    { id: 'foreign', kind: 'pwsh', status: 'running', ownerSession: 'other' },
    { id: 'unowned', kind: 'pwsh', status: 'running' },
  ]), kill: vi.fn(), wait: vi.fn().mockResolvedValue({ status: 'killed' }) };
  expect(ownedBackgroundJobs(jobs, owner, 'conv').map(job => job.id)).toEqual(['own', 'done']);
  await stopBackgroundJobs(jobs, owner, 'conv');
  expect(jobs.kill).toHaveBeenCalledTimes(1);
  expect(jobs.kill).toHaveBeenCalledWith('own', owner);
  expect(jobs.wait).toHaveBeenCalledWith('own', 5000, owner);
  expect(ownedBackgroundJobs(jobs, undefined, 'conv')).toEqual([]);
});
it('does not report a still-stopping job as cancelled successfully', async () => {
  const jobs = { list: () => [{ id: 'own', kind: 'pwsh', status: 'stopping', ownerSession: 'conv' }], kill: vi.fn(), wait: vi.fn().mockResolvedValue({ status: 'stopping' }) };
  await expect(stopBackgroundJobs(jobs, {}, 'conv')).rejects.toThrow('后台任务仍在停止');
});
