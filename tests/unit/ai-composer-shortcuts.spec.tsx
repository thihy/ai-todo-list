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
  return { queue, steer, key, node };
}

describe('AI queue and steer shortcuts', () => {
  it('keeps selected send action, primary button and keyboard shortcuts aligned', async () => {
    const h = await setup('queue');
    const select = h.node.querySelector<HTMLSelectElement>('[aria-label="消息发送方式"]')!;
    await act(async () => { select.value = 'steer'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await h.key(); expect(h.steer).toHaveBeenCalledOnce();
    await h.key({ ctrlKey: true }); expect(h.queue).toHaveBeenCalledOnce();
    await act(async () => h.node.querySelector<HTMLButtonElement>('[aria-label="引导当前任务"]')!.click());
    expect(h.steer).toHaveBeenCalledTimes(2);
  });
  it('groups attachment actions and native skills in the add menu while preserving the draft', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    (window as any).todoList = { skill: { list: vi.fn().mockResolvedValue({ ok: true, data: [
      { name: 'local-review', description: '检查本地代码', userInvocable: true },
      { name: 'internal-only', description: '内部技能', userInvocable: false },
    ] }) } };
    const pickFile = vi.fn(), screenshot = vi.fn(), submit = vi.fn();
    const node = document.createElement('div'); document.body.append(node);
    const root = createRoot(node); hosts.push({ root, node });
    function Composer() {
      const [value, setValue] = React.useState('保留这份草稿');
      return <AIComposer value={value} onChange={setValue} attachments={[]} onRemoveAttachment={() => {}} onPickAttachment={pickFile} onScreenshot={screenshot} onPasteFiles={() => {}} onSubmit={submit} onStop={() => {}} busy={false} hasConversation />;
    }
    await act(async () => root.render(<Composer />));
    const open = async () => { await act(async () => (node.querySelector('[aria-label="添加"]') as HTMLButtonElement).click()); };
    const choose = async (name: string) => { await act(async () => ([...node.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes(name)))!.click()); };
    await open();
    expect(node.querySelector('[role="menu"]')?.textContent).not.toContain('internal-only');
    await choose('添加文件'); expect(pickFile).toHaveBeenCalledOnce();
    expect(node.querySelector('[role="menu"]')).toBeNull();
    await open(); await choose('截图'); expect(screenshot).toHaveBeenCalledOnce();
    await open(); await choose('local-review');
    expect(node.querySelector('textarea')!.value).toBe('请使用 local-review 技能：\n保留这份草稿');
    expect(submit).not.toHaveBeenCalled();
    await open();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(node.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(node.querySelector('[aria-label="添加"]'));
  });
  it('discovers native slash commands and selects with the keyboard before submission', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    (window as any).todoList = { skill: { commands: vi.fn().mockResolvedValue({ ok: true, data: [
      { name: 'compact', description: 'Condense history' }, { name: 'skills', description: '技能清单' },
    ] }) } };
    const submit = vi.fn();
    const node = document.createElement('div'); document.body.append(node); const root = createRoot(node); hosts.push({ root, node });
    function Composer() {
      const [value, setValue] = React.useState('/');
      return <AIComposer value={value} onChange={setValue} attachments={[]} onRemoveAttachment={() => {}} onPickAttachment={() => {}} onPasteFiles={() => {}} onSubmit={submit} onStop={() => {}} busy={false} hasConversation />;
    }
    await act(async () => root.render(<Composer />));
    expect(node.querySelectorAll('[role="option"]')).toHaveLength(2);
    const input = node.querySelector('textarea')!;
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(input.value).toBe('/skills'); expect(submit).not.toHaveBeenCalled();
    expect(node.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledOnce();
  });
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
