// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  IconCloseOutline16: () => null, IconPaperclipOutline16: () => null, IconPlusOutline16: () => null, IconSendOutline16: () => null, IconStopFill16: () => null,
}));
import { AIComposer } from '../../src/renderer/dsh/AIComposer';
const hosts: Array<{ root: ReturnType<typeof createRoot>; node: HTMLElement }> = [];
afterEach(async () => { for (const { root, node } of hosts.splice(0)) { await act(async () => root.unmount()); node.remove(); } });

async function setup(enterAction: 'queue' | 'steer', busy = true, block?: { reason: string }) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const queue = vi.fn(), steer = vi.fn();
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node); hosts.push({ root, node });
  await act(async () => root.render(<AIComposer value="message" onChange={() => {}} attachments={[]} onRemoveAttachment={() => {}} onPickAttachment={() => {}} onPasteFiles={() => {}} onSubmit={queue} onSteer={steer} onStop={() => {}} busy={busy} enterAction={enterAction} hasConversation block={block} />));
  const key = async (options: KeyboardEventInit = {}) => { await act(async () => node.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))); };
  return { queue, steer, key };
}

describe('AI queue and steer shortcuts', () => {
  it('defaults Enter to queue and Ctrl+Enter to steer', async () => {
    const h = await setup('queue'); await h.key(); await h.key({ ctrlKey: true });
    expect(h.queue).toHaveBeenCalledTimes(1); expect(h.steer).toHaveBeenCalledTimes(1);
  });
  it('swaps both actions when configured', async () => {
    const h = await setup('steer'); await h.key(); expect(h.steer).toHaveBeenCalledOnce();
    await h.key({ ctrlKey: true }); expect(h.queue).toHaveBeenCalledOnce();
  });
  it('sends normally with either shortcut while idle', async () => {
    const h = await setup('steer', false); await h.key(); await h.key({ ctrlKey: true });
    expect(h.queue).toHaveBeenCalledTimes(2); expect(h.steer).not.toHaveBeenCalled();
  });
  it('preserves newline and IME composition, and blocks requests during approval', async () => {
    const h = await setup('queue'); await h.key({ shiftKey: true }); await h.key({ isComposing: true });
    expect(h.queue).not.toHaveBeenCalled(); expect(h.steer).not.toHaveBeenCalled();
    const blocked = await setup('queue', true, { reason: 'approval pending' }); await blocked.key(); await blocked.key({ ctrlKey: true });
    expect(blocked.queue).not.toHaveBeenCalled(); expect(blocked.steer).not.toHaveBeenCalled();
  });
});
