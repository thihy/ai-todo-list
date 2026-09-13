# ADR-004: Core and AI use independent startup state

- **Status:** Accepted. Implemented.
- **Date:** 2026-09.

## Context

Cold start has two heavy phases: opening the SQLite database,
constructing file stores, and registering business IPC handlers
(needed for *any* user task — core) versus booting DSH, including
its Cordis plugin composition and session-persistence backend
(needed only for the AI pane — AI).

If both must complete before the renderer mounts, an AI-only
failure (e.g. cordis YAML parse error, missing optional plugin,
stale session JSONL) leaves the user with a frozen shell even
though task management would otherwise work. A single binary
"ready / not ready" status cannot distinguish the two failure
modes.

## Decision

- `src/main/startup-state.ts` exposes two independent components,
  each with its own status enum (`pending | loading | ready | failed`),
  phase string, and redacted error message:
  - **core** — settings → data-dir → db-open → file-stores → ipc →
    window. `markCoreReady()` is called *after* every business IPC
    handler is registered, before the deferred AI / SDK /
    migration work runs.
  - **ai** — ai-loading → ai-ready / ai-failed. Driven entirely by
    `getDshRuntime()` resolving in `src/main/index.ts`'s
    post-core-ready background work.
- The renderer subscribes through one IPC channel
  (`app.startup.get`) and one push event (`app:startup`). The
  pattern is *snapshot first, then subscribe* so a transition that
  fires between page-load and listener registration is never lost.
- The renderer's React app only mounts when `core.status === 'ready'`.
  A failed core status shows a fatal splash with a reload / quit
  affordance. An `ai.status === 'failed'` status is shown as a
  non-blocking banner in the AI pane area; the rest of the UI is
  unaffected.
- The `__todo_router__` proxy does not know about startup state; it
  rejects unknown channels as before. There is no special "DSH not
  yet ready" error code at the IPC layer — `ai.ask` simply rejects
  with `dsh_unavailable` when `getDshRuntime()` failed.

## Impact

- An AI-only failure no longer freezes the application. The user
  can read, create, edit, and archive tasks; the AI pane shows a
  banner explaining the failure and what to do.
- A core failure is unambiguous: the splash shows it. There is no
  fallback path that pretends core succeeded.
- The renderer does not need to know which backend subsystem each
  IPC channel belongs to. `app:startup` is the single decision
  surface.

## Boundaries

- This decision is about *startup*. Steady-state AI failures
  (e.g. a provider 4xx mid-conversation) are reported through the
  regular `ai:stream` events, not through `app:startup`.
- In-session retry of a failed AI boot is implemented as UX-01:
  the renderer subscribes to `app:startup` and offers a "重试"
  banner when `ai.status === 'failed'`. Main exposes
  `app.startup.retry { component: 'ai' }`, which enforces
  single-flight (a module-scope guard in `StartupState`) and
  re-runs the same DSH boot path the first-time path uses. Core
  is intentionally not retried in-session — a failed `core`
  means the renderer can't even mount; restart is the only
  recovery.
- Future phases (worker-thread isolation, native tool offload)
  must preserve the two-component split: they may move work
  earlier or later, but they must not collapse the components.
