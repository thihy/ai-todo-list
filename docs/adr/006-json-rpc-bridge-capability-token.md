# ADR-006: JSON-RPC bridge is off by default and gated by a capability token

- **Status:** Accepted. Implemented in `src/main/sdk/bridge.ts`,
  `src/main/settings/store.ts`, and the settings UI bridge pane.
- **Date:** 2026-09.

## Context

`src/main/sdk/bridge.ts` exposes the same TodoListSdk surface over a
local JSON-RPC transport (Unix socket on POSIX, named pipe on Windows)
so external scripts and plugins can drive the app without spawning a
renderer. Before this change, `bootstrap()` started the bridge
unconditionally — any local process that could reach the socket path
could call `todo.create`, `todo.update`, `content.writeBody`, etc.

The bridge is local-only by construction. The threat model that
matters is:

- A **different local user** on a shared host reaches the socket path.
- A **misconfigured daemon / container** with a shared `/tmp` writes
  to our socket.
- A **legitimate user** running our CLI or a plugin accidentally
  corrupts data because the bridge auto-started with the desktop app.

The previous design had no authentication, no rate limit, no payload
size cap, and started unconditionally — every one of those is a
precondition for the threat scenarios above.

## Decision

The bridge is OFF by default. Enabling it is an explicit user choice
(设置 → 外部访问 → 「外部脚本 / 插件访问」). When enabled, the bridge
requires a 32-byte capability token presented on the FIRST line of
every connection as a JSON-RPC extension field
`{ "auth": "<token>" }`. Token comparison uses
`crypto.timingSafeEqual` to avoid leaking prefix / length via timing.

Additional protections, all implemented in
`src/main/sdk/bridge.ts`:

- `MAX_LINE_BYTES = 1 MiB` — a single request line larger than this
  drops the whole connection (no resync attempt).
- `RATE_PER_MINUTE = 600` — sliding-window per-socket rate limit
  (≈10 req/s sustained); exceeding returns JSON-RPC code `-32005`
  (`rate_limited`).
- `ALLOWED_METHODS` — explicit allowlist of accepted methods (data,
  not control flow). Unknown methods return `-32601`.
- `audit()` writes a redacted log line per dispatch; params and the
  token bytes themselves are never logged.

Toggling the flag in Settings persists the intent but takes effect
on the **next** app launch — the existing `bootstrap()` deferred
phase reads `SettingsStore.sdkBridge` and either starts or skips the
bridge. The settings pane surfaces that explicitly.

The capability token is generated on first enable as 32 random bytes
encoded base64url (`generateSdkToken`). Rotation is a separate IPC
(`app.sdkBridge.rotateToken`) that always disables the bridge; the
user re-enables afterwards. Rotation is intentionally NOT silent —
rotating while the bridge is live would surprise clients that didn't
get the new token, which is the wrong default for a capability
mechanism.

## Boundaries

- This decision is about *local* authentication. The socket is
  bounded by the OS to the local machine; we do NOT design for
  remote access (Unix sockets / named pipes do not cross machines).
- The capability token is not a cryptographic authentication of
  remote parties. It gates "did this connection present the secret
  we generated". A local user with read access to the user's
  settings file can extract the token and impersonate. The threat
  model for that is out of scope here.
- The token is intentionally NOT an API key. There is no notion of
  revocation lists, expiry, or per-method scopes. Future hardening
  passes may add per-method ACLs and named-pipe impersonation on
  Windows / `SO_PEERCRED` on Linux to bind the socket fd to a real
  user.
- The `RATE_PER_MINUTE` limit is per-socket. A future iteration
  should add a process-wide counter to defend against many-socket
  flooding.

## Consequences

- Users who previously relied on the bridge starting automatically
  must enable it once and copy the token. The "open shell script,
  run command, see result" workflow is now gated but not removed.
- The settings UI grew a new category (外部访问). This is
  consistent with `docs/architecture.md §8` and surfaces the
  security model instead of leaving it implicit.
- Every existing call site (`createSdk`, `JsonRpcBridge.start()`)
  had to be revisited because the constructor signature grew
  (the `token` is now a constructor option rather than read from
  settings at the call site).
- Logging surface grew: `${userData}/todo-list.log` now has
  `bridge: <phase> ...` lines that ops scripts can grep without
  leaking params.