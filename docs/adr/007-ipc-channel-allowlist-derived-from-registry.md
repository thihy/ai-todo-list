# ADR-007: IPC contract — single source of truth, runtime allowlist

- **Status:** Accepted. Implemented in `src/shared/channels.ts`.
- **Date:** 2026-09.

## Context

The application's IPC contract was declared in two places:

1. **Type-level**: `src/shared/ipc-schema.ts` has the `IpcRegistry`
   interface; `IpcChannelName = keyof IpcRegistry`. The renderer
   side sees channel names as a string-literal union, so a typo at
   the call site is a compile-time error.
2. **Runtime allowlist**: `src/shared/channels.ts` had a
   hand-maintained `ReadonlySet<string>` (`DECLARED_CHANNELS`).
   `router.ts` consults it at boot: `register(channel, ...)` throws
   `unknown_channel` if the channel isn't in the set.

The two places were connected by convention only. Recent commits
(UX-01, SEC-01, OBS-01) added channels to `IpcRegistry` and
forgot to mirror them in `DECLARED_CHANNELS`. The renderer-side
type-check passed; main would have crashed on boot with
`register: unknown_channel app.startup.retry` (or any of the
others) before the renderer could connect. This was caught by the
typecheck-after-the-fix only because the developer happens to run
`pnpm typecheck` before committing — there was no automated guard.

## Decision

`DECLARED_CHANNELS` is now derived from a `RUNTIME_CHANNEL_KEYS`
tuple that's structurally pinned to `keyof IpcRegistry`. The two
sources are required to agree:

- `RUNTIME_CHANNEL_KEYS as const satisfies readonly IpcChannelName[]`
  catches typos in the tuple.
- An `_ExhaustiveCheck` type assertion at module load fails
  the build if `keyof IpcRegistry` contains a key that's missing
  from `RUNTIME_CHANNEL_KEYS`. The error message includes the
  missing key.

This is a TypeScript-level guarantee — no codegen, no test
discipline, no "remember to update both files". The build fails
on drift; CI / pre-commit / `pnpm typecheck` all catch it.

## Boundaries

- This ADR does NOT change the channel naming convention. New
  channels still follow `<area>.<verb>` (e.g.
  `app.sdkBridge.rotateToken`, `app.diagnostics.export`).
- This ADR does NOT introduce an `IpcCode` typed union for
  `fail()` codes. The current handler-side codes are a mix of
  generic (`bad_request`, `version_conflict`, `not_found`) and
  handler-specific (`tag_list_failed`, `todo_create_failed`)
  strings. Renaming 96 call sites to fit a tight taxonomy is a
  separate piece of work and a much bigger blast radius.
- This ADR does NOT add per-payload runtime validation. The
  router still passes `req: unknown` to handlers, which cast to
  their declared `IpcRequest<C>` shape. Adding zod / valibot is
  ARCH-IPC-02 territory.

## Consequences

- The IPC channel allowlist is now compile-time-checked.
- New channels require TWO edits in `src/shared/`:
  `ipc-schema.ts` (the registry interface) and `channels.ts` (the
  runtime keys). Forgetting either fails the build.
- The redundant regression tests in `tests/unit/channels.spec.ts`
  that pinned specific channel sets (`ai.conversation.*`,
  `app.focus.*`, `app.openTaskDir`) are still useful as
  documentation but no longer carry the burden of "this is the
  only place drift gets detected".
- A future channel that needs to be in the registry but NOT
  registered at boot (e.g. one registered conditionally on
  settings) must still be in the runtime keys — the allowlist
  gates the call, not the registration.