import { expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ app: { getPath: () => '.' }, BrowserWindow: { getAllWindows: () => [] }, dialog: {} }));
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/ipc/router', async importOriginal => {
  const actual = await importOriginal<typeof routerModule>();
  return { ...actual, register: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) };
});
import { registerAiHandlers } from '../../src/main/ipc/ai-handlers';
import type { DshHandle } from '../../src/main/dsh/types';
import type * as routerModule from '../../src/main/ipc/router';

it.each(['ai.userApproval.grantAlways', 'ai.userApproval.grantSession'])('rejects stale clients invoking %s', async channel => {
  registerAiHandlers({} as DshHandle);
  const result = await handlers.get(channel)!(null, { reqId: 'pending', toolName: 'pwsh', conversationId: 'conversation' });
  expect(result).toMatchObject({ ok: false, code: 'tool_grants_disabled' });
});
