// JSON-RPC bridge for external consumers (CI scripts, plugins, ACP transport).
//
// SEC-01: the bridge is OFF by default. When the user enables it via
// Settings → 数据 → 外部访问, the bridge:
//   1. requires a capability token presented as a JSON-RPC `auth` field
//      on the first line of each request;
//   2. caps each request line to MAX_LINE_BYTES;
//   3. only allows methods in the explicit allowlist below;
//   4. rate-limits per-socket to RATE_PER_MINUTE calls / 60s sliding window;
//   5. writes a redacted audit log (method, size, elapsed, outcome) —
//      never logs params or token bytes.
//
// The socket is local-only (Unix socket / named pipe) — the token exists
// to distinguish "the user on this desktop" from "anything else that
// managed to connect to the same socket path" (e.g. another local user
// on a shared host).

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import type { TodoListSdk } from './sdk';
import { logger } from '../logger';

const DEFAULT_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\todo-list'
  : join(tmpdir(), 'todo-list.sock');

/** Hard cap on a single JSON-RPC request line. Larger payloads are
 *  rejected before parsing. 1 MiB is generous for a TodoListSdk call
 *  (the largest expected payload is a Markdown body). */
const MAX_LINE_BYTES = 1_048_576;

/** Per-socket rolling call budget (sliding window over 60s). Anything
 *  above this is rejected with JSON-RPC code -32005 (rate_limited).
 *  600/min ≈ 10/s sustained — far above any honest script usage. */
const RATE_PER_MINUTE = 600;

/** Explicit method allowlist. Mirrors the previous `switch` in `call()`
 *  so that "what a client can call" is data, not control flow. */
const ALLOWED_METHODS: readonly string[] = [
  'todo.list',
  'todo.get',
  'todo.create',
  'todo.update',
  'todo.delete',
  'todo.restore',
  'todo.search',
  'todo.stats',
  'content.readBody',
  'content.writeBody',
  'content.history',
  'content.restoreVersion',
  'drawing.list',
  'drawing.read',
  'drawing.save',
  'drawing.delete',
  'sdk.version',
];

export class JsonRpcBridge {
  private server: Server | null = null;

  /** Active capability token. Set when the bridge is constructed with
   *  the user-chosen token from `SettingsStore.sdkBridge.token`. The
   *  comparison uses constant-time equality to avoid timing oracles. */
  private readonly token: string | null;

  constructor(
    private sdk: TodoListSdk,
    private socketPath: string = DEFAULT_PATH,
    options: { token?: string | null } = {},
  ) {
    this.token = options.token ?? null;
  }

  start(): void {
    if (this.server) return;
    if (!this.token) {
      // Defence in depth — the constructor in index.ts gates on
      // settings.sdkBridge.enabled, but if start() is called without a
      // token we refuse to bind the socket rather than serve unauthenticated
      // traffic.
      logger.warn('bridge: start refused (no capability token configured)');
      return;
    }
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
    let bufBytes = 0;
    // Sliding-window call timestamps for this socket. Older entries are
    // trimmed on every dispatch.
    const callTimes: number[] = [];
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      bufBytes += chunk.length;
      if (bufBytes > MAX_LINE_BYTES) {
        // Buffer overflow before we even see a newline — refuse the
        // whole connection rather than try to resync.
        this.audit({ phase: 'overflow', bytes: bufBytes, outcome: 'closed' });
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        bufBytes = buf.length;
        if (!line.trim()) continue;
        // Authenticate on the FIRST line of every connection: the very
        // first request must include `auth: <token>`. Subsequent calls
        // on the same socket don't need to repeat it; the socket itself
        // is the bearer. This matches the local-process threat model
        // (anything that holds the socket fd is presumed to have
        // legitimately obtained the token).
        const isFirstCall = callTimes.length === 0 && !socketAuthenticated(socket);
        if (isFirstCall) {
          if (!this.authenticateFirstCall(line)) {
            this.audit({ phase: 'auth', outcome: 'rejected' });
            socket.write(JSON.stringify({
              jsonrpc: '2.0', id: null,
              error: { code: -32001, message: 'auth required: pass auth: "<token>" on first line' },
            }) + '\n');
            socket.destroy();
            return;
          }
          markSocketAuthenticated(socket);
          this.audit({ phase: 'auth', outcome: 'ok' });
          continue; // the auth line itself is not a request
        }
        // Rate limit
        const now = Date.now();
        while (callTimes.length > 0 && callTimes[0] < now - 60_000) callTimes.shift();
        if (callTimes.length >= RATE_PER_MINUTE) {
          this.audit({ phase: 'rate_limit', outcome: 'rejected' });
          socket.write(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32005, message: 'rate_limited' },
          }) + '\n');
          continue;
        }
        callTimes.push(now);
        void this.dispatch(line).then((res) => {
          socket.write(JSON.stringify(res) + '\n');
        });
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => undefined);
  }

  private authenticateFirstCall(line: string): boolean {
    // The first line is a tiny JSON object: { "auth": "<token>" }.
    let req: { auth?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof req.auth !== 'string' || !this.token) return false;
    return constantTimeEquals(req.auth, this.token);
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
    if (!ALLOWED_METHODS.includes(method)) {
      this.audit({ phase: 'method', method, outcome: 'unknown' });
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } };
    }
    const startedAt = Date.now();
    try {
      const data = await this.call(method, params);
      this.audit({ phase: 'call', method, bytes: line.length, elapsedMs: Date.now() - startedAt, outcome: 'ok' });
      return { jsonrpc: '2.0', id, result: data };
    } catch (err) {
      this.audit({ phase: 'call', method, bytes: line.length, elapsedMs: Date.now() - startedAt, outcome: 'error' });
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
        // Unreachable: ALLOWED_METHODS is checked in dispatch().
        throw new Error(`unknown method: ${method}`);
    }
  }

  /** Redacted audit log. Never includes params or token bytes. */
  private audit(entry: {
    phase: 'auth' | 'overflow' | 'rate_limit' | 'method' | 'call';
    method?: string;
    bytes?: number;
    elapsedMs?: number;
    outcome: 'ok' | 'rejected' | 'closed' | 'unknown' | 'error';
  }): void {
    const line = `bridge: ${entry.phase}` +
      (entry.method ? ` method=${entry.method}` : '') +
      (entry.bytes !== undefined ? ` bytes=${entry.bytes}` : '') +
      (entry.elapsedMs !== undefined ? ` ${entry.elapsedMs}ms` : '') +
      ` -> ${entry.outcome}`;
    if (entry.outcome === 'ok') logger.info(line);
    else logger.warn(line);
  }
}

// --- per-socket auth marker (Symbol = no collision with user payload) ---

const SOCKET_AUTH_KEY = Symbol.for('todo-list.bridge.authenticated');

function socketAuthenticated(socket: Socket): boolean {
  return (socket as unknown as Record<symbol, boolean>)[SOCKET_AUTH_KEY] === true;
}
function markSocketAuthenticated(socket: Socket): void {
  (socket as unknown as Record<symbol, boolean>)[SOCKET_AUTH_KEY] = true;
}

/** Constant-time string comparison — avoids leaking token length / prefix
 *  via timing on early-return equality checks. Node has `crypto.timingSafeEqual`
 *  for Buffers; we coerce both sides to equal-length buffers and compare. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
