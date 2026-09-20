import { describe, expect, it, vi } from 'vitest';
import { TurnFailureGuard } from '../../src/main/dsh/turn-failure';

const call = (name: string, callId = 'call-1') => ({ type: 'tool/call', data: { name, callId } });
const result = (isError: boolean, text: string, callId = 'call-1') => ({
  type: 'tool/result',
  data: { message: { source: { callId }, content: [{ isError, content: [{ type: 'text', text }] }] } },
});

describe('filesystem turn failure', () => {
  it.each(['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh'])('cancels %s failures once and retains the original error', name => {
    const cancel = vi.fn();
    const guard = new TurnFailureGuard(cancel);
    guard.observe(call(name));
    guard.observe(result(true, 'EACCES: permission denied'));
    guard.observe({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    guard.observe(result(true, 'second failure'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(guard.error?.message).toContain('EACCES: permission denied');
    expect(guard.error?.message).toContain(name);
  });

  it('allows successful file operations, domain errors and user cancellation', () => {
    const cancel = vi.fn();
    const guard = new TurnFailureGuard(cancel);
    guard.observe(call('read', 'read'));
    guard.observe(call('todo_create', 'todo'));
    guard.observe(result(true, 'invalid title', 'todo'));
    guard.observe(result(false, 'contents', 'read'));
    guard.observe(call('write'));
    guard.observe(result(true, 'cancelled: user'));
    expect(guard.error).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps concurrent turns isolated', () => {
    const cancelA = vi.fn(), cancelB = vi.fn();
    const a = new TurnFailureGuard(cancelA), b = new TurnFailureGuard(cancelB);
    a.observe(call('edit')); b.observe(call('read'));
    a.observe(result(true, 'old text not found'));
    b.observe(result(false, 'contents'));
    expect(cancelA).toHaveBeenCalledOnce();
    expect(cancelB).not.toHaveBeenCalled();
    expect(b.error).toBeUndefined();
  });

  it('surfaces errors swallowed by the DSH driver before whenIdle resolves', () => {
    const guard = new TurnFailureGuard(vi.fn());
    guard.observe({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider failed' } } } });
    expect(guard.error?.message).toBe('provider failed');
  });
});
