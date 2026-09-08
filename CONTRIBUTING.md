# Contributing

Thanks for your interest in thihy-todolist. This file is short because the
project is young — most of the conventions live in
[DEVELOPING.md](../DEVELOPING.md).

## Workflow

1. Fork and clone.
2. Create a branch from `main` named `feat/<short-topic>` or `fix/<short-topic>`.
3. Make changes. Keep commits small. Reference the OpenSpec change id if
   the change implements a spec delta.
4. `pnpm typecheck && pnpm lint && pnpm test`.
5. Open a PR with a short rationale and a checklist of what was tested.

## Adding a new IPC channel

1. Add the channel name + request/response types to
   `src/shared/ipc-schema.ts`.
2. Add a corresponding method to `src/shared/thihy-api.ts`.
3. Register a handler in the relevant `src/main/ipc/<area>-handlers.ts`.
4. Wrap the renderer call in a hook inside
   `src/renderer/hooks/useThihyApi.ts`.
5. Add a unit test for the handler logic where possible.

## Adding a new DSH tool

1. Pick a tier in `src/main/dsh/tools.ts`.
2. Implement the tool in `registerDshTools`.
3. Add it to the relevant skill in `src/main/dsh/skills.ts`, or create a
   new skill if it belongs to a new domain.
4. Document in `openspec/specs/ai-assistant/spec.md`.

## Style

- TypeScript strict.
- No unused imports; `pnpm lint` enforces.
- Prefer named exports.
- Comments only where the code is genuinely surprising; otherwise let the
  code speak.

## Reporting issues

Include:

- OS + version
- Node + pnpm versions (`node -v && pnpm -v`)
- Reproduction steps
- Output of `${userData}/thihy.log` (last 200 lines is plenty)
