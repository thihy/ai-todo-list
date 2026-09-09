// JSON-RPC bridge for external consumers (CI scripts, plugins, ACP transport).
//
// Listens on a Unix socket (Linux/macOS) or named pipe (Windows) and exposes the
// same operations as ThihySdk over JSON-RPC 2.0. Each request is one of:
//
//   { jsonrpc: '2.0', id, method: 'todo.list', params: { filter } }
//   { jsonrpc: '2.0', id, method: 'content.writeBody', params: { id, markdown } }
//   ...
//
// This is intentionally a minimal, line-delimited transport: one JSON object per
// line, response is one JSON object per line. It does not implement streaming;
// consumers that need streaming should drive the AI pane via ai.ask IPC instead.

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { ThihySdk } from './sdk';
import { logger } from '../logger';

const DEFAULT_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\thihy-todolist'
  : join(tmpdir(), 'thihy-todolist.sock');

export class JsonRpcBridge {
  private server: Server | null = null;

  constructor(private sdk: ThihySdk, private socketPath: string = DEFAULT_PATH) {}

  start(): void {
    if (this.server) return;
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        logger.warn(`bridge: cannot remove stale socket: ${(err as Error).message}`);
      }
    }
    mkdirSync(dirname(this.socketPath), { recursive: true });
    this.server = createServer((socket) => this.handle(socket));
    this.server.listen(this.socketPath);
    this.server.on('error', (err) => logger.error(`bridge: ${err.message}`));
    logger.info(`JSON-RPC bridge listening on ${this.socketPath}`);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(socket: Socket): void {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        void this.dispatch(line).then((res) => {
          socket.write(JSON.stringify(res) + '\n');
        });
      }
    });
    socket.on('error', () => undefined);
  }

  private async dispatch(line: string): Promise<unknown> {
    let req: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    const { id, method, params } = req;
    if (req.jsonrpc !== '2.0' || typeof method !== 'string') {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'invalid request' } };
    }
    try {
      const data = await this.call(method, params);
      return { jsonrpc: '2.0', id, result: data };
    } catch (err) {
      const message = (err as Error).message;
      return { jsonrpc: '2.0', id, error: { code: -32000, message } };
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const args = (params as Record<string, unknown>) ?? {};
    switch (method) {
      case 'todo.list': return this.sdk.todo.list((args.filter as never) ?? {});
      case 'todo.get': return this.sdk.todo.get(args.id as string);
      case 'todo.create': return this.sdk.todo.create(args.input as never);
      case 'todo.update': return this.sdk.todo.update(args.id as string, args.patch as never);
      case 'todo.delete': this.sdk.todo.delete(args.id as string); return { ok: true };
      case 'todo.restore': this.sdk.todo.restore(args.id as string); return { ok: true };
      case 'todo.search': return this.sdk.todo.search(args.query as string, args.limit as number | undefined);
      case 'todo.stats': return this.sdk.todo.stats(args.windowDays as number | undefined);
      case 'content.readBody': return this.sdk.content.readBody(args.id as string);
      case 'content.writeBody': return this.sdk.content.writeBody(args.id as string, args.markdown as string, args.expectVersion as number | undefined);
      case 'content.history': return this.sdk.content.history(args.id as string);
      case 'content.restoreVersion': this.sdk.content.restoreVersion(args.id as string, Number(args.versionId)); return { ok: true };
      case 'drawing.list': return this.sdk.drawing.list(args.todoId as string);
      case 'drawing.read': return this.sdk.drawing.read(args.id as string);
      case 'drawing.save': return this.sdk.drawing.save(args.todoId as string, args.scene as never, args.id as string | undefined, args.title as string | undefined);
      case 'drawing.delete': this.sdk.drawing.delete(args.id as string); return { ok: true };
      case 'sdk.version': return this.sdk.version;
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }
}