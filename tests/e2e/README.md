# E2E tests

Playwright drives the packaged Electron app. These tests are intentionally
minimal at first cut — they verify the boot path and the IPC plumbing, not
the full UI surface.

## Running

```bash
pnpm e2e
```

`@playwright/test` will launch the app via `playwright._electron.launch({ args: ['.'] })`,
which uses the current build. If you have not run `pnpm build` yet, the
launch will fail with a "main entry not found" error pointing at `out/main/index.js`.

## What's covered

- `boot.spec.ts` — App boots, sidebar is visible.

## What's not (yet)

- TODO creation flow (depends on running capture window, which Playwright
  can't reach via `firstWindow` in headless mode).
- Drawing pane Excalidraw mount — needs the lazy chunk loaded; mark
  `test.fixme` until chunk loading is plumbed into the harness.
- AI streaming round-trip — needs a real DeepSeek API key in CI.
