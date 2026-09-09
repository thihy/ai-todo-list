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

  it('accepts the full ai.conversation.* set (L4 regression guard)', () => {
    // channels.ts and ipc-schema.ts must agree on every conversation
    // channel — if DECLARED_CHANNELS forgets one, the renderer's
    // window.todoList.conversation.* calls fail with unknown_channel.
    const set = [
      'ai.conversation.list',
      'ai.conversation.create',
      'ai.conversation.rename',
      'ai.conversation.archive',
      'ai.conversation.unarchive',
      'ai.conversation.delete',
      'ai.conversation.confirmDelete',
      'ai.conversation.history',
    ];
    for (const c of set) {
      expect(isKnownChannel(c)).toBe(true);
    }
  });

  it('accepts the app focus + openTaskDir set (#174b regression guard)', () => {
    // DocumentsView's fullscreen button + the open-directory icon both
    // depend on these three being in DECLARED_CHANNELS. If the schema adds
    // a channel but channels.ts misses it, the renderer call fails silently
    // — pin them.
    for (const c of ['app.focus.set', 'app.focus.get', 'app.openTaskDir']) {
      expect(isKnownChannel(c)).toBe(true);
    }
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