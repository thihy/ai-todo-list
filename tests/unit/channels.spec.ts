import { describe, it, expect } from 'vitest';
import { isKnownChannel, assertKnownChannel } from '../../src/shared/channels';

describe('IPC channel registry', () => {
  it('accepts declared channels', () => {
    expect(isKnownChannel('todo.list')).toBe(true);
    expect(isKnownChannel('todo.create')).toBe(true);
    expect(isKnownChannel('ai.ask')).toBe(true);
    expect(isKnownChannel('settings.set')).toBe(true);
    expect(isKnownChannel('capture.submit')).toBe(true);
  });

  it('rejects unknown channels', () => {
    expect(isKnownChannel('todo.explode')).toBe(false);
    expect(isKnownChannel('foo.bar')).toBe(false);
    expect(isKnownChannel('')).toBe(false);
  });

  it('assertKnownChannel throws on unknown', () => {
    expect(() => assertKnownChannel('nope' as never)).toThrow(/unknown_channel/);
  });

  it('assertKnownChannel returns the channel on hit', () => {
    expect(assertKnownChannel('todo.list')).toBe('todo.list');
  });
});