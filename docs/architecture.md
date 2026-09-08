# Architecture

Deeper notes on the thihy-todolist architecture. For the high-level overview
and diagram see [README.md](../README.md); this file goes into the parts
that didn't fit.

## Boot sequence

1. `src/main/index.ts` requests the single-instance lock. The second invocation
   sees the lock denied and quits; the first instance focuses its existing window.
2. `app.whenReady()` resolves; we open the SQLite database under
   `${userData}/../thihy-todolist/todos.db` (WAL mode, foreign keys on).
3. We construct `TodoRepo`, `MarkdownStore`, `DrawingStore`, `SettingsStore`.
4. `installRouter()` registers a single `ipcMain.handle('__thihy_router__', ...)`
   that validates channel names against `shared/channels.ts` before delegating
   to per-channel handlers. This pattern means **unknown channels are always
   rejected**, regardless of whether a handler exists.
5. `initDshContainer()` tries to `require('@deepseek-ai/dsh-base')`. On success
   we boot it inside a Cordis container and register our domain tools. On failure
   (missing peer, RC version drift) we fall back to a shim that registers tools
   against a tiny in-process registry — the app stays usable, the surface stays
   identical.
6. `CaptureController`, `TrayController`, `ClipboardWatcher` are wired up.
7. The main window is created with `titleBarStyle: 'hiddenInset'`,
   `backgroundColor: '#0F172A'`, and the preload script loaded with
   `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.

## IPC contract

Every renderer→main call funnels through `__thihy_router__`. The renderer sends
`(channel, payload)`; main looks up `channel` in the allowlist, runs the
handler, and returns `IpcResult<T>` = `{ ok: true, data }` or
`{ ok: false, code, message }`.

Channels are declared in `shared/ipc-schema.ts` and registered in main via
`register(channel, handler)`. The TypeScript type system guarantees the
request/response shapes match.

Stream-style events flow **main→renderer** via `ipcRenderer.on(channel, ...)`:
the renderer subscribes through `window.thihy.on('app:*' | 'ai:stream', cb)`.
The list of allowed event names lives in `preload/index.ts`.

## DSH integration

The agent runtime is shaped exactly like DSH: a Cordis container, a tool
registry, a 3-tier permission gate, and a stream of `ai:stream` events. We
ship an **in-process shim** instead of the published `@deepseek-ai/dsh-base`
because the rc/next packages on npm currently depend on packages that aren't
on the registry (e.g. `dsh-bash-env` returns 404).

The shim lives in `src/main/dsh/container.ts`:

```ts
export async function initDshContainer(args: InitArgs): Promise<DshHandle> {
  let container: DshContainer;
  try {
    const real = await loadRealDsh();      // currently dead code; ready when upstream is fixed
    container = await real.boot({ logger });
  } catch {
    container = bootShim();                 // registers tools, no LLM call yet
  }
  registerDshTools(container, { ...args, send });
  return { container, invoke, cancel, models, health };
}
```

To wire real DSH in later: `pnpm add @deepseek-ai/dsh-base@^0.1.0 @deepseek-ai/cordis@^4`,
remove the `try`/`catch` short-circuit, and the same `DshContainer` interface is served
to the rest of the app.

### Permission tiers

| Tier         | Tools (subset)                         | UX                                       |
| ------------ | -------------------------------------- | ---------------------------------------- |
| auto         | read-only, search                      | runs without confirmation                |
| notify-undo  | writes that have an in-app inverse     | undo toast for 8 seconds                 |
| block        | deletes, irreversible history restore  | modal confirmation dialog                |

The mapping is centralised in `src/main/dsh/tools.ts`. To add a new tool:

1. Pick a tier; add the tool name to the corresponding set.
2. Implement the tool inside `registerDshTools` with a wrapper that handles
   `toolResult` event emission.
3. Add a unit test in `tests/unit/permissions.spec.ts`.

## Storage

### SQLite

`better-sqlite3` with WAL mode. Migrations live inline in
`src/main/db/schema.ts`; each migration is a `(version, sql[])` tuple applied
on `openDb()`. The schema is the source of truth — adding a column means a
new migration entry, not an `ALTER TABLE` hand-edit.

FTS5 covers `todos.title`, `todos.tags`, and `body_search` (the markdown
content). Inserts/deletes propagate via triggers.

### Markdown files

`MarkdownStore` writes each TODO body to `<todosDir>/<id>.md` with a YAML
front-matter (`title`, `updatedAt`, `version`). On write we snapshot the
previous content into `content_versions` and trim to `MAX_BODY_VERSIONS = 20`.

### Drawings

`DrawingStore` writes each drawing as `<drawingsDir>/<id>.json` containing the
Excalidraw scene (`elements`, `appState`). Thumbnails are kept as data URLs
in the SQLite `drawings.thumb` column.

## External SDK

`ThihySdk` is the programmatic handle for scripts and plugins. It mirrors
the IPC surface one-to-one. `JsonRpcBridge` exposes the same surface over a
Unix socket (Linux/macOS) or named pipe (Windows), so external Node scripts
can drive the app:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"todo.list","params":{"filter":{}}}' \
  | nc -U /tmp/thihy-todolist.sock
```

The bridge is **off by default** in production builds — only enabled when the
`--enable-sdk-bridge` CLI flag is passed. This prevents surprising port
behaviour for users who never asked for it.

## Renderer architecture

- `App.tsx` is a thin shell: Topbar / Sidebar / main pane / Statusbar in a
  CSS Grid.
- `router.ts` is a 50-line hash-based router — no react-router dependency
  despite it being in the manifest; we kept it minimal because routing is
  straightforward.
- `hooks/useThihyApi.ts` is the only place where the renderer talks to
  `window.thihy`; panes never touch `window.thihy` directly.
- `panes/` are route-level views; `components/` are leaf widgets.
- The capture window is a separate HTML entry (`capture.html`) so it doesn't
  pull in the full main app bundle.
