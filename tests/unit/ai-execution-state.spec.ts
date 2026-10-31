import { expect, it } from 'vitest';
import { AIExecutionRegistry } from '../../src/main/ai/execution-state';

it('keeps stopping invocations running until their real completion, with immutable revisioned snapshots', () => {
  const registry = new AIExecutionRegistry();
  const finish = registry.begin('conversation', 'first');
  const running = registry.snapshot('conversation');
  registry.stopping('conversation');
  const stopping = registry.snapshot('conversation');
  expect(running.invocations[0]?.phase).toBe('running');
  expect(stopping.invocations[0]?.phase).toBe('stopping');
  expect(stopping.revision).toBeGreaterThan(running.revision);
  finish();
  expect(registry.snapshot('conversation').invocations).toEqual([]);
});

it('does not let an earlier invocation clear newer work or another conversation', () => {
  const registry = new AIExecutionRegistry();
  const first = registry.begin('conversation', 'first');
  registry.begin('conversation', 'second'); registry.begin('other', 'other');
  first(); first();
  expect(registry.snapshot('conversation').invocations.map(item => item.invocationId)).toEqual(['second']);
  expect(registry.snapshot('other').invocations).toHaveLength(1);
});
