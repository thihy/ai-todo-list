# thihy-todolist

> AI-native desktop TODO list built on DeepSeek Harness (DSH) — the agent runtime is wired through the same DSH-shaped interface (Cordis container + tool registry + 3-tier permission gate) so you can drop in a real DSH build later without touching call sites.
> Capture fast, organize freely, write Markdown notes, sketch on Excalidraw, and ask the assistant directly — all inside one Electron app.

![status](https://img.shields.io/badge/status-alpha-yellow)
![electron](https://img.shields.io/badge/electron-33-47848F)
![dsh](https://img.shields.io/badge/DSH-in--process-blue)

## Highlights

- **Quick capture** — global hotkey `Ctrl+Shift+T` opens a small always-on-top composer.
  Drop a line, press `Ctrl+Enter`, back to whatever you were doing.
- **Markdown per TODO** — each TODO carries a full Markdown body with up to 20 historical
  versions. Restore any of them in one click.
- **Excalidraw sketches** — attach drawings to any TODO; thumbnails show up in the
  editor and open in a dedicated pane.
- **AI-native** — built **on top of** DSH, not bolted on. `todo.*`, `content.*`, and
  `drawing.*` are first-class DSH tools; the agent can read, draft, and update your
  work just like a teammate. Three-tier permission (auto / notify+undo / block)
  decides what the agent can do without asking.
- **No telemetry** — your API key, your data, your disk. JSON-RPC bridge over a
  Unix socket / Windows named pipe is the only external surface, and it only listens
  when you run the app.

## Quick start

```bash
pnpm install          # .npmrc enables shamefully-hoist + auto-install-peers
pnpm rebuild          # rebuild better-sqlite3 against Electron's Node ABI
node resources/build-tray-icon.mjs
pnpm dev
```

The app launches with an empty in-memory database under your platform's userData
directory. Drop your DeepSeek API key into **Settings → DeepSeek API Key**,
pick a model, and ask away.

## Build & ship

```bash
pnpm build            # produce out/ via electron-vite
pnpm typecheck        # tsc --noEmit across the three projects
pnpm test             # vitest run (unit + bridge + skills)
pnpm e2e              # playwright (requires pnpm build first)

pnpm dist             # electron-builder, native target
pnpm dist:win         # NSIS installer + portable
pnpm dist:mac         # DMG (x64 + arm64)
pnpm dist:linux       # AppImage + .deb
```

## Architecture

```
┌─────────────────────── Renderer (React 18 + TS) ───────────────────────┐
│   Sidebar  │  TODO List  │  Editor (Markdown + Drawing)  │  AI Pane   │
│                       ▲ window.thihy.* (contextBridge)                  │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ __thihy_router__ (validated IPC)
┌─────────────────────── Main Process ───────────────────────────────────┐
│  ipc/router ─ todo/content/drawing/inbox/settings/ai handlers         │
│       │                                                               │
│       ├── db/TodoRepo ─┐                                              │
│       ├── files/MD  ──┴── better-sqlite3 + Markdown files             │
│       ├── files/Drawings (JSON scenes + thumbs)                       │
│       │                                                               │
│       └── dsh/container ── in-process Cordis container                │
│              ├── dsh/tools ── todo.*, content.*, drawing.*            │
│              ├── dsh/skills ── grouped tool bundles                   │
│              └── dsh/client ── DeepSeek API (streaming fetch)         │
└───────────────────────────────────────────────────────────────────────┘
                        ▲
                        │ JsonRpcBridge (Unix socket / named pipe)
                        │
        ┌───────────────┴───────────────┐
        │   External scripts / plugins  │
        │   $ echo '{"jsonrpc":"2.0",   │
        │   "id":1,"method":"todo.list",│
        │   "params":{}}' | nc -U …sock│
        └───────────────────────────────┘
```

## DSH integration model

The agent runtime is wired through a **DSH-shaped interface** — a Cordis container
plus a tool registry plus a 3-tier permission gate — but ships as an **in-process shim**
(see `src/main/dsh/container.ts`). The shim implements the same tool surface as real DSH
so the app is fully usable today.

### Why a shim, not the published `@deepseek-ai/dsh-base`?

The published rc/next packages on npm (as of 2026-09) reference `@deepseek-ai/dsh-bash-env`
and several other packages that **are not on the registry** — `pnpm install` fails with
`ERR_PNPM_FETCH_404`. Until that resolves upstream, we ship the shim.

### Swapping in real DSH later

When the upstream packages become installable:

```bash
pnpm add @deepseek-ai/dsh-base@^0.1.0 @deepseek-ai/cordis@^4
```

Then replace `bootShim()` in `src/main/dsh/container.ts` with `loadRealDsh()` (already
written — currently dead code). The rest of the app is unchanged because every call site
goes through `DshContainer`.

Three permission tiers, from `src/main/dsh/tools.ts`:

| Tier         | Example tools                    | UI                                  |
| ------------ | -------------------------------- | ----------------------------------- |
| auto         | `todo.list`, `content.readBody`  | runs silently                       |
| notify-undo  | `todo.update`, `content.writeBody` | 8-second undo toast                |
| block        | `todo.delete`, `content.restoreVersion` | explicit confirmation dialog    |

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` everywhere.
- Preload exposes only the typed `window.thihy.*` facade; the raw `ipcRenderer`
  is never reachable from page code.
- CSP set in both `index.html` and `capture.html`.
- API key is persisted under the OS userData dir and never re-sent to the renderer
  in cleartext — `publicView()` returns only a redacted version.

## Accessibility

- WCAG 2.2 AA contrast for all foreground/background pairs in
  `src/renderer/styles/global.css` (computed via Python — see
  `openspec/changes/todo-list-desktop/ui-wireframe.md`).
- `prefers-reduced-motion` honored in global CSS.
- Every tappable element has press + commit states (see `PriorityPicker`,
  `TagInput`, `NavItem`).
- Live regions: statusbar (`aria-live="polite"`), AI pane (`role="log"`).

## License

MIT — see [LICENSE](./LICENSE).

## See also

- [DEVELOPING.md](./DEVELOPING.md) — local dev loop, code layout, conventions.
- [docs/architecture.md](./docs/architecture.md) — deeper architecture notes.
- [openspec/changes/todo-list-desktop/](./openspec/changes/todo-list-desktop/) — design specs.
