# ADR-003: DSH enters the application through a stable integration layer

- **Status:** Accepted. Partially implemented — DSH is real, lazy,
  and behind `getDshRuntime()`. The "stable integration layer" is
  in place (`src/main/dsh/` boundary); full UI primitive reuse is
  still in flight.
- **Date:** 2025-09 (initial); refined 2026-09.

## Context

DSH (`@deepseek-ai/dsh-*`) ships a Cordis-driven runtime, an LLM
adapter layer, and a UI primitives package
(`dsh-client-ui-primitives`). Two integration pressures exist:

1. The runtime itself is heavy and boots slowly. The first second
   of cold start is dominated by cordis plugin composition and
   session-persistence backend initialisation.
2. DSH's UI primitives (`Button`, `DisclosureRow`,
   `RiskConfirmation`, `MarkdownText`, …) are reusable, but the
   `InputBar` requires session / input / slot services that are
   not provided as a turnkey bundle. A drop-in replacement would
   couple our Electron host to DSH's service plumbing.

Earlier designs (visible in older `docs/architecture.md` revisions)
shipped an "in-process shim" that registered tools against a
local registry when the npm packages weren't available. That shim
is **no longer the active path** — DSH packages install and run.

## Decision

- DSH integration lives behind a stable boundary:
  `src/main/dsh/container.ts` (eager bootstrap handle with
  `health` + `models`) and `src/main/dsh/dsh-runtime.ts`
  (`getDshRuntime(deps)`, lazy on first `ai.ask`).
- The renderer's contract is `window.todoList.ai.ask` /
  `ai.cancel` / `ai.health` / `ai.models` / `ai.conversation.*` /
  `ai.userQuestion.answer` / `ai.userApproval.answer`. The renderer
  never imports `@deepseek-ai/dsh-*` directly.
- Tool definitions and parameter shapes live in `dsh-runtime.ts`.
  The AI behavior contract lives in
  `resources/dsh/cordis.yml`. No tool name or shape may leak into
  the renderer except via the IPC surface.
- UI primitive reuse is opt-in per component, behind host-owned
  adapters (`AIComposer`, `PendingQuestionCard`,
  `PendingApprovalCard`). A full InputBar integration is a
  separate, future decision.
- `DSH_SESSIONS_ROOT` is set to `${dataDir}/dsh-sessions` *before*
  the cordis YAML is loaded; the YAML evaluates `!js` expressions
  at parse time and would otherwise see `undefined`.

## Impact

- Switching DSH versions, swapping the LLM adapter, or
  substituting a different runtime (e.g. for tests) is a change
  isolated to `src/main/dsh/`. The IPC schema and renderer do not
  have to move.
- The `AIComposer` / `PendingQuestionCard` adapters give us a
  single seam to swap between fully host-owned primitives and
  official `dsh-client-ui-*` packages without rewriting the AI
  pane shell.
- The lazy boot means the splash + core data are usable before
  DSH finishes; `ai.ask` may reject with `dsh_unavailable` on a
  failed boot, but task management continues.

## Boundaries

- DSH plugin code does not touch the SQLite handle directly. All
  DB writes go through `TodoRepo` / `TagRepo` /
  `ConversationRepo` so the integration layer cannot break the
  source-of-truth invariant (ADR-001).
- The renderer's `dsh` packages, where used, are pinned via
  `package.json`; the integration boundary treats them as
  consumer libraries, not as a service runtime.
- A future proposal that would replace the boundary entirely
  (e.g. a hosted AI service) needs a new ADR — this one does not
  authorise that change.
