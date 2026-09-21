// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PendingApprovalCard } from '../../src/renderer/dsh/PendingApprovalCard';

let root: Root;
let host: HTMLDivElement;
const session = vi.fn().mockResolvedValue({ ok: true });
const always = vi.fn().mockResolvedValue({ ok: true });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (window as any).todoList = { aiUserApproval: { grantSession: session, grantAlways: always } };
  session.mockClear(); always.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('offers only request-scoped approval inside the modal', async () => {
  const allow = vi.fn();
  act(() => root.render(<PendingApprovalCard toolName="pwsh" reason="Run command" reqId="request" conversationId="conversation" onAllow={allow} onReject={vi.fn()} />));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  const button = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '本次允许')!;
  expect(dialog.textContent).not.toContain('本次会话允许');
  expect(dialog.textContent).not.toContain('始终允许');
  expect(button).toBeDefined();
  expect(button.disabled).toBe(true);
  expect(session).not.toHaveBeenCalled(); expect(always).not.toHaveBeenCalled();
  act(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(allow).toHaveBeenCalledOnce();
  expect(session).not.toHaveBeenCalled();
  expect(always).not.toHaveBeenCalled();
});
