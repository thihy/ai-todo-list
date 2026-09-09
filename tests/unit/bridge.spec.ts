// Unit tests for the JSON-RPC bridge. Uses a real unix socket in tmpdir.
//
// On Windows, node:net.createServer().listen('.sock') fails with EACCES
// because Win32 only supports named pipes for AF_UNIX-like local IPC. The
// production bridge falls through to a named pipe path on win32, but this
// test uses a Unix socket path directly so the server-side `listen` is
// portable. We skip on win32 — production IPC smoke tests on Windows run
// through the named-pipe branch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, createConnection } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonRpcBridge } from '../../src/main/sdk/bridge';
import type { ThihySdk } from '../../src/main/sdk/sdk';

const SOCKET = join(tmpdir(), `thihy-bridge-test-${Date.now()}.sock`);

const fakeSdk: ThihySdk = {
  todo: {
    list: () => [{ id: 't1', title: 'hello', status: 'next', priority: 'p2', tags: [], createdAt: 0, updatedAt: 0 } as never],
    get: () => null,
    create: () => ({ id: 't2' } as never),
    update: () => ({ id: 't3' } as never),
    delete: () => undefined,
    restore: () => undefined,
    search: () => [],
    stats: () => ({ total: 1, done: 0, inProgress: 0, completionRate: 0, aiInvocations: 0, aiCostUsd: 0 }),
  },
  content: {
    readBody: () => ({ body: '', version: 0 }),
    writeBody: () => ({ body: '', version: 1 }),
    history: () => [],
    restoreVersion: () => undefined,
  },
  drawing: {
    list: () => [],
    read: () => ({ scene: { elements: [] }, meta: { id: 'd1' } as never }),
    save: () => ({ id: 'd2' } as never),
    delete: () => undefined,
  },
  version: '0.1.0',
};

let bridge: JsonRpcBridge;

const isWin = process.platform === 'win32';

beforeAll(() => {
  if (isWin) return;
  bridge = new JsonRpcBridge(fakeSdk, SOCKET);
  bridge.start();
  // Give the server a tick to bind
  return new Promise<void>((resolve) => setTimeout(resolve, 50));
});

afterAll(() => {
  if (isWin) return;
  bridge.stop();
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
});

function call(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET);
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        const lines = text.split('\n').filter(Boolean);
        const responses = lines.map((l) => JSON.parse(l));
        // Return the last response that matches our id
        const last = responses[responses.length - 1];
        resolve(last);
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
    const req = { jsonrpc: '2.0', id: 1, method, params };
    sock.end(JSON.stringify(req) + '\n');
  });
}

describe.skipIf(isWin)('JsonRpcBridge', () => {
  it('returns sdk.version', async () => {
    const res = (await call('sdk.version', {})) as { result: string };
    expect(res.result).toBe('0.1.0');
  });

  it('forwards todo.list', async () => {
    const res = (await call('todo.list', { filter: {} })) as { result: Array<{ id: string }> };
    expect(res.result).toHaveLength(1);
    expect(res.result[0].id).toBe('t1');
  });

  it('rejects unknown method with -32000', async () => {
    const res = (await call('bogus.method', {})) as { error: { code: number } };
    expect(res.error.code).toBe(-32000);
  });

  it('returns parse error on bad json', async () => {
    const res = await new Promise<{ error: { code: number } }>((resolve, reject) => {
      const sock = createConnection(SOCKET);
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8').trim())));
      sock.on('error', reject);
      sock.end('not-json\n');
    });
    expect(res.error.code).toBe(-32700);
  });
});

// Suppress unused-import warning
void createServer;