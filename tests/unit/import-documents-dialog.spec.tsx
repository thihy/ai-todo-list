// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDocumentsDialog } from '../../src/renderer/components/ImportDocumentsDialog';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('document import dialog', () => {
  let host: HTMLDivElement; let root: Root;
  const importing = vi.fn(); const paths = vi.fn(); const close = vi.fn(); const refreshed = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn();
    (window as any).todoList = { document: { import: importing, pathsForFiles: paths } };
    importing.mockResolvedValue({ ok: true, data: { files: [{ fileName: 'A.md' }] } });
    paths.mockReturnValue(['C:\\A.md']); refreshed.mockResolvedValue(undefined);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<ImportDocumentsDialog todoId="real-task" onClose={close} onImported={refreshed} />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  it('opens a modal and imports from the local picker', async () => {
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '选择本地文件')!;
    await act(async () => button.click());
    expect(importing).toHaveBeenCalledWith('real-task', undefined);
    expect(refreshed).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  });
  it('accepts supported drops only inside the dialog and passes local paths', async () => {
    const drop = host.querySelector('dialog > div')!;
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['# hi'], 'A.md')] } });
    await act(async () => drop.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(importing).toHaveBeenCalledWith('real-task', ['C:\\A.md']);
  });
  it('rejects unsupported drops and leaves the dialog open after failures or cancellation', async () => {
    const drop = host.querySelector('dialog > div')!;
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['bad'], 'A.pdf')] } });
    await act(async () => drop.dispatchEvent(event));
    expect(importing).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('仅支持');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '选择本地文件')!;
    importing.mockResolvedValueOnce({ ok: false, message: '磁盘不可写' });
    await act(async () => button.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('磁盘不可写');
    expect(close).not.toHaveBeenCalled();
    importing.mockResolvedValueOnce({ ok: true, data: { files: [] } });
    await act(async () => button.click());
    expect(close).not.toHaveBeenCalled();
  });
});
