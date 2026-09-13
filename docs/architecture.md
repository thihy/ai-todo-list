# Architecture

Source-of-truth guide to how **AI待办** is actually wired together today.
Every file path, IPC channel, event name, and security setting named in
this document can be found by `grep` in the current source tree.

> **Task-creation and storage contract.** This document intentionally
> does not duplicate the task-creation paths, AI intent envelope, or
> the per-task file projection rules. Read
> [`docs/task-creation-and-storage.md`](./task-creation-and-storage.md)
> alongside this one — that document is authoritative for those areas
> and is updated together with the relevant source.

> **Architecture decisions.** Short, durable ADRs (background, decision,
> impact, boundaries) live in [`docs/adr/`](./adr/). When a section
> below cites "ADR-xxx" it points there.

## Document conventions

The body of each section is divided into three labeled bands:

- **Current state** — what the source actually does today, with file
  pointers the reader can verify.
- **Known issues** — concrete gaps acknowledged by the source but not
  yet closed. These are real risks, not aspirations.
- **Target state** — directional plans; never claimed as already done.
  Anything from the `docs/architecture-improvement-roadmap.md` or the
  `docs/proposals/` folder belongs here unless the source confirms
  otherwise.

## 1. Process layout

Three processes cooperate:

| Process         | Entry point                                | Role                                                                 |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Main (Node)     | `src/main/index.ts`                        | Lifecycle, DB, file stores, IPC handlers, AI runtime, tray, updater |
| Preload (Node)  | `src/preload/index.ts` (built to `index.cjs`) | Single contextBridge surface exposed as `window.todoList`            |
| Renderer (Chromium) | `src/renderer/index.html` → `main.tsx` → `App.tsx` | React UI; reaches main only via `window.todoList.*`                 |

A fourth, optional renderer entry `src/renderer/capture.html` (loaded
through `src/main/shortcuts/capture.ts`) hosts the quick-capture
window opened from the global hotkey. It is the only second window the
app currently creates; it shares the same preload script and the same
`window.todoList` bridge.

### 1.1 Main entry — `src/main/index.ts`

**Current state.**

1. **Single-instance lock** (`requestSingleInstanceLock`) — second
   launches surface the existing window via the `second-instance`
   handler. DEV escape hatch: `ELECTRON_ALLOW_MULTI_INSTANCE=1`
   disables the lock when Ctrl+C orphans the previous process.
2. **Privileged scheme registration** — `protocol.registerSchemesAsPrivileged`
   declares `app://` (renderer assets) and `attachment://`
   (inbox_attachments bytes) as standard + secure + fetch + CORS
   enabled, **before** `app.whenReady()` resolves. This is required:
   the renderer cannot use a scheme that wasn't registered first.
3. **`app.whenReady()` → `bootstrap()`** — every subsequent step is
   sequenced inside one async function. Phase markers are tracked by
   `src/main/startup-state.ts` so the renderer can paint a non-React
   splash and wait for `core: ready` before mounting React (see
   §1.3).
4. **Settings** — `SettingsStore` reads `${userData}/config.json` (a
   stable path independent of `dataDir`) to obtain the data directory
   `${dataDir}`.
5. **Directory bootstrap** — `${dataDir}`, `${dataDir}/todos`,
   `${dataDir}/drawings`, `${dataDir}/inbox-attachments` are created
   with `mkdirSync({recursive:true})`. Constants come from
   `src/shared/constants.ts`: `ROOT_DIR_NAME = '.todo-list'`,
   `DB_FILENAME = 'db.sqlite'`, `TODOS_SUBDIR = 'todos'`,
   `DRAWINGS_SUBDIR = 'drawings'`, `ATTACHMENTS_SUBDIR = 'inbox-attachments'`.
6. **Database** — `openDb(dbPath)` from `src/main/db/schema.ts`
   opens `db.sqlite` in WAL mode, runs all un-applied migrations
   inline (current `SCHEMA_VERSION = 17`), and returns a `DbHandle`
   that is shared by every repo.
7. **Tag catalog post-migration backfill** — `TagRepo.ensureFromTagsTable`
   inserts any task-applied names that v17 missed, then
   `TagRepo.importEntries(settings.get().tags ?? [])` is the **one
   and only** legacy import from `config.json`. After this point,
   `settings.set({ tags: … })` is silently ignored; the DB catalog is
   authoritative.
8. **Repositories and file stores** — `TodoRepo(handle.db, onTagsAttached)`
   (the hook routes every new/updated tag name into the catalog),
   `TagRepo(handle.db)`, `ConversationRepo(handle.db)`,
   `TaskDirectoryStore`, `MarkdownStore`, `DrawingStore`,
   `DocumentStore`, `InboxStore`.
9. **IPC router + handlers** — `installRouter()` registers the single
   `ipcMain.handle('__todo_router__', …)` proxy; every business
   module (`registerTodoHandlers`, `registerContentHandlers`,
   `registerDocumentHandlers`, `registerLinkHandlers`,
   `registerInboxHandlers`, `registerTagHandlers`,
   `registerSettingsHandlers`, `registerAppHandlers`,
   `registerCaptureHandlers`, `registerCapturePreviewHandler`,
   `registerAiHandlers`, `registerStartupHandler`) calls
   `register(channel, handler)` and the router validates each channel
   against the allowlist in `src/shared/channels.ts`.
10. **`startupState.markCoreReady()`** — flips the core component to
    `ready`; the renderer's splash observes this through `app:startup`
    events and only then mounts the React app.
11. **Background work** — DSH runtime (`initDshContainer` +
    `registerAiHandlers` + `bindAiDeps`), SDK bridge, v1→v2 layout
    migration (`migrateV1Layout`), orphan-session backfill
    (`migrateOrphanSessions`), auto-archive sweep, plan reminder,
    capture controller, tray, clipboard watcher, application menu,
    auto-updater — all run as deferred `void (async () => …)()` or
    fire-and-forget after `markCoreReady`. AI and SDK failures log a
    warning and set `ai = failed` / `sdk = skipped`; they never throw
    out of the bootstrap.
12. **Window close / quit** — `main.on('close')` hides to tray in
    production, quits in dev (so the single-instance lock releases);
    `app.on('before-quit')` destroys capture + tray + clears the
    archive interval timer, stops the plan reminder, and closes the DB.

**Known issues.**

- The bootstrap function is still ~480 lines and does too many things.
  See ADR-001 in [`docs/architecture-improvement-roadmap.md`](./architecture-improvement-roadmap.md)
  and ARCH-02 in the same document — that refactor is the next step
  but has not landed.
- The post-migration legacy `settings.tags` import assumes
  `config.json` is readable synchronously. On systems where the user
  data directory is on a slow volume this is the first synchronous
  I/O on the critical path.

**Target state.**

- See ARCH-02 / ARCH-03 in the roadmap: extract `DataServices`,
  `IpcModules`, `BackgroundServices`, `WindowManager`, and the
  startup state machine from `index.ts`. Not yet implemented.

### 1.2 Preload — `src/preload/index.ts`

**Current state.**

- Built output: `out/preload/index.cjs` (referenced as
  `webPreferences.preload` in `createMainWindow()`).
- `contextBridge.exposeInMainWorld('todoList', api)` exposes the
  `TodoListApi` interface from `src/shared/todo-list-api.ts`.
- All renderer→main calls go through `invoke('__todo_router__', channel, req)`;
  the renderer never sees `ipcRenderer` directly.
- All main→renderer events go through `on(event, cb)` (also bridged);
  the allowlist is `APP_EVENTS` in the preload file itself, plus a
  parallel `exposeInMainWorld('__todo_event_channels__', APP_EVENTS)`
  for tests / debugging.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
  (the renderer still uses `require` indirectly through ESM
  imports; this is a known constraint — see known-issues).

**Known issues.**

- `sandbox: false` is intentional today (the renderer entry runs an
  inline `<script>` in `index.html` for the splash that uses
  `window.close()` / `window.location.reload()` without the context
  bridge; turning sandbox on would require rewriting the splash).
  The trade-off is documented inline in `createMainWindow`.
- The event allowlist is duplicated in `APP_EVENTS` and
  `AppEventMap`/`AppEvent`; drift between them is caught only by
  `pnpm typecheck`.

**Target state.**

- ARCH-04 in the roadmap wants a single registry-derived allowlist;
  not yet implemented.

### 1.3 Renderer entry — `src/renderer/index.html` + `main.tsx`

**Current state.**

- Two HTML entries: `src/renderer/index.html` (main app) and
  `src/renderer/capture.html` (capture window). Both load via the
  `app://` custom scheme.
- The main `index.html` ships a non-React splash inside `#splash`
  (inline CSS + inline `<script>` that defines `window.__splash`
  with `setPhase` / `showError` / `remove`). The script runs
  synchronously before the deferred `<script type="module"
  src="./main.tsx">`. The splash paints before any heavy bundle
  downloads.
- `src/renderer/main.tsx`:
  1. reads `window.todoList.app.startupGet()` for the current
     `StartupSnapshot`;
  2. subscribes to `app:startup` events;
  3. when `core.status === 'ready'`, dynamically
     `import('./App')` + `import('react')` + `import('react-dom/client')`,
     creates the React root, and only then calls
     `window.__splash.remove()`.
- `src/renderer/App.tsx` is the shell. It uses
  `React.lazy` + `Suspense` for `SettingsModal`, `TodoEditorPane`,
  `StatsPane`, `DrawingPane`, and `DocumentsView`. Only
  `TodoListPane`, `Topbar`, `Statusbar`, and the chrome are statically
  imported.
- Routing is a hand-rolled hash router (`src/renderer/router.ts`,
  ~115 lines). There is no `react-router` dependency.
- Data hooks live in `src/renderer/hooks/useTodoListApi.ts` —
  `useTodos`, `useTodo`, `useSettings`, `useSettingsPatchWithToast`,
  `useTagCatalog`, `useTagList`, `useSearch`, `useStats`, etc.
  Cross-window data invalidation is mediated by the
  `src/renderer/data-bus.ts` per-scope counters.

**Known issues.**

- The renderer's first mount depends on `window.__splash` existing;
  the inline script in `index.html` is the only thing that makes it
  available before the bundle parses.
- The dynamic-import chain (`App` → React → react-dom/client) is
  partly an artifact of the splash logic; future refactors may
  collapse it once `App.tsx` is no longer required to be lazy-imported.

**Target state.**

- Long-term: treat the splash as a thin React island, or move to a
  single React render from the start. Currently deferred.

## 2. Window lifecycle and security

**Current state.**

- `createMainWindow()` in `src/main/index.ts` builds a single
  `BrowserWindow` with:
  - `show: false` until `ready-to-show`;
  - `backgroundColor: '#FFFFFF'` (avoids the default white flash
    while the renderer paints);
  - frameless `titleBarStyle: 'hidden'` with a `titleBarOverlay`
    coloured `#F6F7F9` (icon-glyph colour `#4A4F57`, height 44) so
    the native min/max/close stays usable;
  - `autoHideMenuBar: true` (menu hides until Alt is pressed);
  - icon `resources/icon.ico` on Windows, `icon.png` elsewhere (the
    `.ico` is required for the Windows taskbar);
  - `webPreferences`: `contextIsolation: true`,
    `nodeIntegration: false`, `sandbox: false`, `preload` pointing
    at the compiled `out/preload/index.cjs`.
- Renderer URL: in dev, `process.env['ELECTRON_RENDERER_URL']`; in
  production, `app://todo-list/index.html`.
- `setWindowOpenHandler` denies all `window.open` and forwards to
  `shell.openExternal` instead.
- `protocol.handle('app', …)` serves files under `out/renderer`
  through `net.fetch('file://…')`.
- `protocol.handle('attachment', …)` serves `inbox_attachments` row
  bytes back to the renderer without ever exposing the on-disk path.

**Known issues.**

- The CSP shipped in `index.html` allows `https://rsms.me` to load
  Inter from the rsms CDN; for fully-offline operation this should
  become a local copy. Not a security issue, only a deployment one.
- `sandbox: false` is a known renderer hardening gap; see §1.2.

## 3. IPC contract

**Current state.**

- Single proxy channel `__todo_router__` from `ipcMain.handle` in
  `src/main/ipc/router.ts`. Every renderer call carries
  `(channel, payload)`; the router rejects channels not declared in
  `src/shared/channels.ts`'s `DECLARED_CHANNELS` set.
- Type discipline is enforced by `IpcChannelName`, `IpcRequest<C>`,
  `IpcResponse<C>` from `src/shared/ipc-schema.ts` — every channel
  in `IpcRegistry` declares both shapes.
- Handlers register themselves through `register(channel, handler)`
  from `src/main/ipc/router.ts`. Each module owns its own handler
  file (todo, content, document, link, inbox, tag, settings, app,
  capture, ai, startup). See §1.1 step 9 for the file list.
- Responses are always `IpcResult<T> = { ok:true, data } | { ok:false, code, message }`.
  Handlers that need to translate a thrown exception into a typed
  failure should do so explicitly (most existing handlers wrap in
  `try/catch` and call `failResult('snake_case_code', err.message)`).
- Stream-style events flow main→renderer through the
  `window.todoList.on(event, cb)` bridge. The complete list of
  push-direction event names lives in `APP_EVENTS` in
  `src/preload/index.ts`. Adding an event requires: (1) updating
  `AppEvent` and `AppEventMap` in `src/shared/todo-list-api.ts`;
  (2) adding the channel name to `APP_EVENTS`; (3) wiring the
  broadcast in main (`BrowserWindow.webContents.send(...)`).
- Coarse-grained cross-window invalidation: `app:data-changed`
  carries `{ scope: 'todos' | 'content' | 'drawings' | 'conversations' | 'tags' }`.
  The renderer's `data-bus` keeps per-scope monotonic counters; hooks
  opt in via `useDataVersion([scope])`.

**Known issues.**

- The router's `unknown_channel` rejection log uses
  `logger.warn('router: unknown_channel rejected: <channel>')`, which
  is noisy if the renderer fires requests during a reload. Not
  blocking; tracked as minor.
- Channel allowlist in `channels.ts` is a hand-maintained `Set`. ARCH-04
  wants a registry-derived allowlist.

**Target state.**

- See ARCH-04 in the roadmap.

## 4. SQLite, repositories, and file projections

**Current state.**

- `src/main/db/schema.ts` is the single source of truth for the
  schema. `SCHEMA_VERSION = 17`. Each migration is a `{ version,
  sql }` tuple; `openDb()` applies every migration whose version is
  greater than `MAX(schema_meta.version)`. Foreign keys are disabled
  for the migration phase (so DROP/rebuild migrations don't cascade-
  delete children) and re-enabled afterwards.
- FTS5 table `todos_fts` covers `title` + `body` via the
  external-content pattern; insert/delete triggers keep it in sync
  with the `todos` table. Marked deprecated in older comments, but
  still active — `repo.search` uses it.
- Repositories live in `src/main/db/`:
  - `TodoRepo` — wraps `todos`, `tags`, `progress_log`,
    `content_versions`, `link_index`. Reads return rich `Todo`
    objects with `tags`, `drawingIds`, `attachmentIds` joined in.
  - `TagRepo` (v17) — owns `tag_catalog` (name PRIMARY KEY,
    color, retired_at). Provides `list` / `activeCatalog` /
    `ensureFromTagsTable` / `activateUsedNames` / `rename` /
    `merge` / `previewCleanup` / `applyCleanup` / `reactivate`.
  - `ConversationRepo` — wraps `ai_conversations` (DSH session
    history) and `ai_messages`.
- File projections live in `src/main/files/`:
  - `MarkdownStore` — owns `progress.html` and per-task `note_md`
    bodies; writes are wrapped in a transaction with `todos.body`
    and `content_versions`.
  - `DrawingStore` — owns `{drawingId}.excalidraw` JSON scenes
    and `thumbs/{drawingId}.thumb.png`.
  - `DocumentStore` — owns `task_documents` and
    `document_versions`; this is the v9+ rich-document index that
    supersedes the older `MarkdownStore`-only body model.
  - `InboxStore` — owns `inbox_attachments` rows and the on-disk
    file bytes under `{storage_dir}/attachments/`.
  - `TaskDirectoryStore` — owns `todos.storage_dir`; this is the
    single resolver every file store reaches through to locate a
    task's directory. Stable per-id; rename only happens after a
    successful filesystem rename (see ADR on directory stability in
    AGENTS.md).
- Storage paths come from `src/shared/constants.ts`
  (`ROOT_DIR_NAME`, `DB_FILENAME`, `TODOS_SUBDIR`, etc.) plus
  `src/main/files/paths.ts` for slug rules.
- The `git-history.ts` module manages a per-task `.git` repo for
  `progress.html` history when Git is available on `PATH`; failures
  degrade silently and the DB content_versions table remains the
  source of truth.

**Known issues.**

- `TaskDirectoryStore.findLegacyDir` walks the FS for v1 layout
  names on first resolution. On a very large legacy install this
  is the slowest non-DB step in `TodoRepo.create` / `update`.
- `progress_log` rows can accumulate quickly; there is no
  automated compaction beyond the per-write burst-merge window.

**Target state.**

- ARCH-05 / D in the roadmap — split monolithic stores into
  feature-aligned ones. Currently deferred.

## 5. Task creation and storage

**Current state.**

- See [`docs/task-creation-and-storage.md`](./task-creation-and-storage.md)
  for the authoritative contract.
- Two creation paths:
  - **Form** — `src/renderer/components/Composer.tsx` calls
    `window.todoList.todo.create(input)` directly. No AI, no intent
    envelope, no inference.
  - **AI** — the renderer sends an explicit envelope through
    `ai.ask` with `intent: 'create-task'`; main encodes the
    `[todo-list:create-task:v1]` envelope in
    `src/shared/task-creation.ts`. The fixed creation rules live in
    `resources/dsh/cordis.yml` under `创建任务操作`. Historical
    sessions are decoded strictly; loose marker matching is
    forbidden.
- Tag catalog (v17): the `tag_catalog` table is the source of
  truth; the legacy `settings.tags` field is imported once at boot
  and then ignored. Renames and merges are restricted to valid-task
  associations; historical-task associations are never rewritten.
  See ADR on the tag catalog in `docs/adr/`.

## 6. DSH runtime and AI integration

**Current state.**

- DSH integration is **real**, not a shim. The previous "fallback
  shim" design described in older docs has been replaced.
- `src/main/dsh/container.ts` returns a tiny bootstrap handle
  (`{ health, models }`) so `ai.health` / `ai.models` work before
  credentials are resolved. The handle logs `'DSH handle ready
  (real runtime is lazy on first ai.ask)'`.
- `src/main/dsh/dsh-runtime.ts` exposes `getDshRuntime(deps)` which
  lazily `await import('@deepseek-ai/dsh-app-boot')` on the first
  `ai.ask`. The boot config is `resources/dsh/cordis.yml`; the
  `DSH_SESSIONS_ROOT` env var is set to
  `${dataDir}/dsh-sessions` *before* the import because cordis YAML
  loader evaluates `!js` expressions at parse time.
- The runtime registers DSH tools, session persistence (JSONL via
  `dsh-session-persistence-jsonl`), and the human-in-the-loop
  bridges for `ask_user_question` / `user-approval`. The renderer
  consumes these as `ai.userQuestion.answer` / `ai.userApproval.answer`
  IPC calls plus push events `ai:user-question-request`,
  `ai:user-approval-request`, plus their timeouts.
- LLM adapter (`src/main/dsh/llm-adapter.ts`) is provider-agnostic.
  Providers are configured through `src/main/dsh/endpoints.ts`,
  which honours `'deepseek'`, `'openai'`, `'anthropic'`, `'gemini'`,
  `'ollama'`, `'shim'` (offline / no-creds), and `'custom'`
  (user-defined base URL + key). When `shim` is selected,
  `ai.health` returns `{ ok:false, mode:'shim' }` and `ai.ask`
  short-circuits.
- Tool descriptions and parameter shapes are centralised in
  `dsh-runtime.ts`; the AI behavior contract is in
  `resources/dsh/cordis.yml`.

**Known issues.**

- Lazy DSH boot is the dominant cold-start cost after the splash
  landed. The startup-state AI component (`pending` → `ready` /
  `failed`) exposes this to the renderer; the renderer shows
  "AI 正在准备" in the AI pane area without blocking the rest of
  the UI. A failed DSH boot surfaces as
  `ai.ask → dsh_unavailable`; task management continues to work.
- AI init failure does not roll back core-ready. The app stays
  usable for non-AI flows; the AI pane is disabled until next
  launch (no auto-retry in the current source).
- The boot costs are still measured per phase via the
  `startup[ai]` log lines in `${userData}/todo-list.log`; the
  optimizer (worker-thread split, native tool offload) is not
  done.

**In-session AI retry (UX-01).**

After a failed DSH boot the renderer can ask main to retry
without quitting the app. The path is:

1. `AIPane.tsx` subscribes to `app:startup` via
   `useStartupAiState()` (renderer hook in
   `src/renderer/hooks/useTodoListApi.ts`). When
   `ai.status === 'failed'` it renders a banner with a
   "重试" button.
2. The button calls `window.todoList.app.startupRetry('ai')`,
   which lands on `app.startup.retry { component: 'ai' }` in
   `src/main/ipc/startup-handler.ts`. The handler enforces
   single-flight: concurrent retries return
   `{ accepted: false, reason: 'already_in_flight' }` (or
   `'not_failed'` if the AI component is already ready / loading).
3. On accepted retry, main calls
   `startupState.tryStartAiRetry()`, which owns the loading
   transition + a single-flight guard
   (`StartupState.aiRetryInFlight`). The closure supplied by
   `src/main/index.ts` (`bootAiAndDispatch('retry')`) then
   re-runs the same DSH boot the first-time path runs.
4. Before re-booting, `resetDshRuntimeForRetry()` (exported
   from `src/main/dsh/dsh-runtime.ts`) disposes any cached
   `DshRuntime` and nulls the `runtimePromise` so the next
   `getDshRuntime()` triggers a fresh boot.
5. Boot outcome flows through `markAiReady()` /
   `markAiFailed(reason)` (unchanged) and is pushed to the
   renderer as `app:startup`. `finishAiRetry()` clears the
   single-flight guard.
6. The renderer hook observes the push event and re-renders
   without polling. AI pane is fully usable again once the
   status reaches `ready`.

`SettingsModal.tsx` also wires auto-retry: when the AI
component is currently `failed` and the user saves a model /
provider / API key / custom provider change, the renderer calls
`app.startupRetry('ai')` immediately so a corrected
configuration flips the AI pane back online without the user
having to bounce to the AI pane.

This feature closes the UX gap that previously forced a full
quit-and-relaunch to recover from `ai.status === 'failed'`. It
does **not** introduce a new IPC surface for arbitrary config
changes, does **not** add a second AI boot path, and does
**not** change the core / ai startup independence — `core`
remains untouched and task management stays usable throughout
the retry.

**Target state.**

- ARCH-03 / F / G in the roadmap — tighter AI / DSH boundary,
  cleaner component adoption. `docs/proposals/dsh-component-adoption.md`
  describes a phased migration onto `dsh-client-ui-*` packages.
  `docs/proposals/aipane-rendering-upgrade.md` is **historical** —
  it proposes a DSH stream chunk protocol that does not match the
  current `BlockAssembler` design; do not treat it as a target.

## 7. Core / AI startup independence

**Current state.**

- `src/main/startup-state.ts` holds two independent components:
  - `core` — `pending` → `loading` (phase walk) → `ready` / `failed`.
    The renderer waits on `core.status === 'ready'` before mounting
    React; failed surfaces the error + a reload / quit button.
  - `ai` — `pending` → `loading` → `ready` / `failed`. The renderer
    shows "AI 正在准备" in the AI pane area while `pending`;
    `failed` becomes a permanent banner until the user quits.
- Renderer subscribes via `app.startup.get()` (snapshot query) +
  `app:startup` event push. The pattern is "subscribe first, then
  read snapshot" — see `src/renderer/main.tsx` for the exact order.
- This split is the implementation of ADR-004 (Core / AI independent
  startup state) — see `docs/adr/`.

**Known issues.**

- Once `ai.status === 'failed'`, the renderer offers no in-session
  retry; the user must quit and relaunch. A "Retry AI" affordance
  is a candidate future feature.

**Target state.**

- ARCH-03 / I in the roadmap — first-paint performance and richer
  retry UI.

## 8. External SDK and JSON-RPC bridge

**Current state.**

- `src/main/sdk/sdk.ts` exposes `TodoListSdk` mirroring the IPC
  surface. `src/main/sdk/bridge.ts` exposes the same surface over
  JSON-RPC 2.0 (line-delimited, one JSON object per line) on a
  Unix socket (`/tmp/todo-list.sock`) or Windows named pipe
  (`\\.\pipe\todo-list`).
- The bridge starts ONLY when `SettingsStore.sdkBridge.enabled`
  is true AND a capability token exists (SEC-01). It is read at
  the same deferred phase as before (`markCoreReady()` + post),
  but the bootstrap body now early-returns with an info log when
  the flag is off. Toggling the flag in Settings takes effect on
  the next launch — the pane surfaces that explicitly.
- Each bridge request maps to a `TodoListSdk` call; streaming is
  not supported — consumers that need streaming should drive the
  AI pane via `ai.ask` IPC instead.

**SEC-01 — Capability token and access protection.**

When enabled, the bridge requires a capability token presented
on the FIRST line of every connection as a JSON-RPC extension
field (`{ "auth": "<token>" }`). The comparison uses
`crypto.timingSafeEqual` to avoid leaking token length / prefix
via timing.

Additional protections in `src/main/sdk/bridge.ts`:

- `MAX_LINE_BYTES = 1 MiB` — a single request line larger than
  this drops the whole connection (no resync).
- `RATE_PER_MINUTE = 600` — sliding-window per-socket limit
  (≈10 req/s sustained). Exceeding returns JSON-RPC code
  `-32005` (`rate_limited`).
- `ALLOWED_METHODS` — explicit list of accepted methods (data,
  not control flow). Unknown methods return `-32601`
  (`unknown method`).
- `audit()` writes a redacted log line per dispatch
  (`bridge: <phase> method=<m> bytes=<n> <ms>ms -> <ok|error>`).
  Params and the token itself are never logged.

The capability token is generated on first enable as 32 random
bytes encoded base64url (`src/main/settings/store.ts →
generateSdkToken`). Rotation is a separate IPC
(`app.sdkBridge.rotateToken`) that always disables the bridge;
the user re-enables afterwards. The token is treated as
sensitive but is NOT an API key — its sole purpose is
"distinguish a script the user trusts on the same machine from
anything else that managed to reach the local socket path".

**Known issues.**

- On Windows, the named-pipe path cannot be exposed across
  machines; same constraint as the older docs noted.
  Additionally the current code does NOT tighten pipe ACLs to
  user-level access; a future iteration should call
  `SetSecurityInfo` / `ConvertStringSecurityDescriptorToSecurityDescriptor`
  with a DACL scoped to the owner's SID.
- The bridge does not authenticate the caller beyond the
  capability token; any local process that reads the token out
  of the user's settings can impersonate. Acceptable for the
  current threat model (single-user desktop); a future
  iteration could use named-pipe impersonation on Windows /
  SO_PEERCRED on Linux to bind the socket fd to a real user.
- The rate limit is per-socket; a malicious client could open
  many sockets in parallel. The current limit is sized for
  honest script usage; a future hardening pass should add a
  process-wide counter.

## 9. Process exit / resource release

**Current state.**

- `app.on('before-quit', ...)` handler in `src/main/index.ts`
  destroys `CaptureController`, destroys `TrayController`, closes
  the SQLite `DbHandle`, clears the archive interval timer, stops
  the plan reminder, stops the JSON-RPC bridge (registered inside
  the SDK bootstrap `void (async () => …)()`).
- Tray close → window hides (production) or quits (dev) via
  `main.on('close')`. `window-all-closed` does not quit (the app
  lives in the tray until the user explicitly quits).
- Closing the SQLite handle is idempotent — `TodoRepo.close()` is
  idempotent and the data-migration path closes early; double-close
  on `better-sqlite3` throws.

**Known issues.**

- If the renderer crashes before `before-quit`, the
  archive-interval timer is cleared but the bridge, tray, and
  capture hotkey may leak. We rely on OS-level cleanup; no
  `app.on('render-process-gone')` cleanup is registered.
- The plan reminder uses `Notification` plus an interval; if the
  interval is still pending when `before-quit` fires, the cleanup
  calls `planReminder.stop()` which clears it.

## 10. Renderer ↔ IPC end-to-end walkthrough

A `todo.create` round-trip — the simplest, complete path from
user action to on-disk projection — runs through:

1. User submits the form in
   `src/renderer/components/Composer.tsx`.
2. Composer calls `window.todoList.todo.create(input)` (defined in
   `src/shared/todo-list-api.ts`).
3. The preload bridge serialises that as
   `ipcRenderer.invoke('__todo_router__', 'todo.create', { input })`.
4. The router validates `'todo.create'` against
   `DECLARED_CHANNELS` in `src/shared/channels.ts` and dispatches to
   the handler registered in `src/main/ipc/todo-handlers.ts`.
5. The handler calls `repo.create(req.input)` →
   `src/main/db/todo-repo.ts`:
   - validates `parentId` against the `todos` table,
   - inserts the `todos` row,
   - inserts rows into `tags` (one per name),
   - bumps `updated_at`,
   - fires the `onTagsAttached` hook so
     `TagRepo.activateUsedNames` can fold the new names into
     `tag_catalog` (reviving retired ones).
6. The handler calls `md.writeBody(todo.id, '')` →
   `src/main/files/markdown.ts` to write the initial
   `progress.html`.
7. The handler calls `writeTodoJson(resolveTaskDir(todo.id), …)` to
   drop `todo.json` into the per-task directory. The directory was
   resolved through `TaskDirectoryStore.resolve(todo.id)` which
   claims a stable name and persists it as `todos.storage_dir`.
8. The handler broadcasts `app:data-changed { scope: 'todos' }` to
   every `BrowserWindow`. The renderer's `data-bus` bumps the
   `'todos'` counter; `useTodos` re-fetches; the new task appears.
9. The handler returns
   `{ ok:true, data: { id, todo } }` to the renderer; Composer
   navigates to the new task via `app:navigate`.

Throughout, no business rule sits in the renderer beyond
field-shape validation. The DB write is atomic; the file projections
are best-effort (logged but not rolled back). The tag catalog row
insertion is part of the `TodoRepo.create` transaction family only
insofar as the hook runs synchronously after the row commits — a
catalog-insert failure cannot corrupt the task.

## 10.1 Diagnostics bundle (OBS-01)

**Current state.**

- `src/main/diagnostics/bundle.ts` builds a redacted JSON snapshot
  in one synchronous pass: app version, OS / arch, DB schema
  version (`SCHEMA_VERSION` constant), live startup-state snapshot
  (already redacted by `redactMessage`), provider name + model
  (NEVER the API key), task counts by status, data-dir sizes,
  `sdkBridge.enabled` flag (NEVER the token), and a 200-line / 32
  KiB tail of the recent log file with paths / keys / emails /
  base64-shaped blobs scrubbed.
- The renderer asks for the bundle via `app.diagnostics.export`,
  then writes it to a user-chosen path via
  `app.diagnostics.saveToFile` (which calls
  `dialog.showSaveDialog` from main and `writeFileSync`).
- `SettingsModal → 关于 → 「导出诊断包…」` is the only UI entry
  point. The default filename is
  `diagnostics-<ISO-timestamp>.json`.

**What is redacted.**

- API keys (custom-provider, provider-level).
- The bridge capability token (32-byte base64url).
- Absolute paths in Windows (`C:\…`) or POSIX (`/home/...`,
  `/Users/...`, etc.) form.
- Anything that looks like a long base64 blob (≥32 chars of
  `[A-Za-z0-9_-]`).
- Emails (`user@host`).

**What is NOT redacted.**

- Task titles / bodies / progress text — not included in the
  bundle. The bundle only has task *counts*, not task *content*.
- Drawing scenes — not included.
- AI conversation bodies — not included.
- Attachments — not included.

**Known issues.**

- The diagnostics module lives in `src/main/`. The renderer sees
  its shape via the mirror in `shared/ipc-schema.ts →
  DiagnosticsBundle` so the web tsconfig (which excludes
  `src/main/`) still type-checks. Drift between the two is not
  checked at compile time — a future iteration could export the
  shared interface as a structural type and have main assert at
  startup that the runtime object satisfies it.
- The bundle is generated synchronously; on a slow disk with
  a large log file the renderer may briefly block. 32 KiB is
  small enough that this is not yet a real problem.

## 11. Cross-references

- **Task creation / storage contract** —
  [`docs/task-creation-and-storage.md`](./task-creation-and-storage.md)
- **Operations** — [`docs/operations.md`](./operations.md) (storage
  locations, log files, recovery; updated alongside this file)
- **Architecture decisions** — [`docs/adr/`](./adr/)
- **Architecture improvement roadmap (forward-looking)** —
  [`docs/architecture-improvement-roadmap.md`](./architecture-improvement-roadmap.md)
  (this is a planning document; do not treat as current state)
- **Historical proposals** —
  [`docs/proposals/aipane-rendering-upgrade.md`](./proposals/aipane-rendering-upgrade.md)
  (superseded),
  [`docs/proposals/dsh-component-adoption.md`](./proposals/dsh-component-adoption.md)
  (in-flight, partial adoption)
