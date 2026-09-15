# Developing

Local dev loop, code layout, conventions.

## Prereqs

- Node ≥ 20.19
- pnpm ≥ 9
- Windows 10/11, macOS 12+, or Linux with `libnss3` / `libgtk-3-0` for Electron.

## Code exploration

The repo ships with a local CodeGraph index under `.codegraph/`
(it is gitignored). Before opening a task, orient yourself:

```bash
codegraph status --no-color          # confirm the index is alive
codegraph sync --no-color            # refresh if Pending Changes > 0
codegraph context "<真实用户行为或数据流>"
```

CodeGraph is excellent for static call relationships but cannot
see IPC channel strings, Electron events, dynamic `import()`,
YAML plugins, CSS classes, or React closure relationships. For
those, run `rg` — see [`docs/code-exploration.md`](docs/code-exploration.md)
for the full mandatory supplement list and three worked
end-to-end examples (form task creation, AI `todo.create`, stable
task-directory resolution).

If `codegraph` is denied by the current Agent sandbox, fall back
to `rg` + hand-traced call chains without stopping the task.
Never invent call relationships from memory.

## First-time setup

```bash
pnpm install                  # .npmrc handles shamefully-hoist + auto-install-peers
pnpm rebuild                  # better-sqlite3 against Electron's Node ABI
node resources/build-tray-icon.mjs
pnpm dev                      # electron-vite dev with HMR
```

### Why `.npmrc` has `shamefully-hoist=true`

pnpm 10's default strict mode (sandboxed builds, separate `node_modules/.pnpm/`)
conflicts with several packages we depend on (electron-builder 26's
multi-package layout, electron-winstaller's postinstall, etc.). Setting
`shamefully-hoist=true` makes pnpm behave like npm for layout purposes —
every direct dep lives at `node_modules/<name>` and postinstall scripts run
automatically. The trade-off is larger `node_modules`, which doesn't matter
for an Electron app.

`capture.html` does not hot-reload; close and reopen it (`Ctrl+Shift+T`) to
pick up changes.

## Project layout

```
src/
├── main/                       Electron main process
│   ├── index.ts                bootstrap, single-instance lock, IPC wiring
│   ├── ipc/                    handler modules + router
│   ├── db/                     better-sqlite3 schema + repositories
│   ├── files/                  Markdown + drawing storage
│   ├── dsh/                    in-process DSH container + tools + skills
│   ├── sdk/                    external TodoListSdk + JSON-RPC bridge
│   ├── settings/               config.json persistence
│   ├── shortcuts/              global hotkey + capture window
│   ├── tray/                   system tray menu
│   ├── clipboard/              tray-triggered clipboard save
│   └── updater/                electron-updater integration
├── preload/
│   └── index.ts                contextBridge → window.todoList.*
├── renderer/                   React app
│   ├── App.tsx                 shell + routing
│   ├── panes/                  TODO list, editor, drawing, AI, inbox, settings, stats
│   ├── components/             Markdown editor, tag input, drawing strip, …
│   ├── layout/                 Sidebar, Topbar, Statusbar
│   ├── hooks/                  typed window.todoList wrappers
│   ├── styles/                 tokens + global.css
│   ├── index.html              main entry
│   └── capture.html            capture window entry
└── shared/                     types & constants used by main + renderer
    ├── todo-types.ts
    ├── ai-types.ts
    ├── ipc-schema.ts
    ├── todo-list-api.ts
    ├── channels.ts
    └── constants.ts
tests/
├── unit/                       vitest specs (no Electron required)
└── e2e/                        playwright specs (electron driver)
openspec/
└── changes/todo-list-desktop/  proposal / design / specs / tasks
```

## Conventions

- **No `any`** outside generated code or `// eslint-disable-next-line` blocks.
- All new IPC channels go through `src/shared/ipc-schema.ts` first.
- Renderer never `require()`s Node modules — only `window.todoList.*`.
- Design tokens live in **one** place: `src/renderer/styles/global.css`. Mirror
  them in `tokens.ts` for TS-side computation; never hardcode colors in components.
- Domain errors are surfaced as `IpcResult.fail(code, message)`; never throw
  across the IPC boundary.
- Tests live next to the spec name (`tests/unit/<area>.spec.ts`).
- OpenSpec tasks are tracked in `openspec/changes/<change>/tasks.md`; check
  the box as you finish each item.

## Useful commands

```bash
pnpm typecheck                  # tsc --noEmit on three projects
pnpm lint                       # eslint over .ts / .tsx
pnpm test                       # vitest run
pnpm test:watch                 # vitest in watch mode
pnpm test:cov                   # coverage
pnpm e2e                        # playwright

pnpm build                      # produces out/{main,preload,renderer}
pnpm dist:dir                   # unpacked app under dist/
pnpm dist                       # native installer
```

## Smoke test after install

1. `pnpm dev` — main window opens.
2. Press `Ctrl+Shift+T` — capture window appears.
3. Type "smoke test todo" + `Ctrl+Enter`.
4. The new TODO appears in the list view.
5. Click it → editor opens → type some Markdown → press `Ctrl+S` → status flips
   to "已保存".
6. Click "🤖 问 AI" → AI pane opens → ask "今天我应该先做什么？" → stream tokens.
7. Tray icon → right-click → menu shows.

If any step fails, check `todo-list.log` in your userData dir.

## Troubleshooting

### `pnpm dev` opens no window (orphaned single-instance lock)

The app takes a single-instance lock on startup (`app.requestSingleInstanceLock()`
in `src/main/index.ts`). On Windows, Ctrl+C'ing `pnpm dev` sometimes orphans the
Electron child process, which keeps holding the lock — so the next `pnpm dev`
gets `gotLock=false`, calls `app.quit()`, and never opens a window.

The fix is the `ELECTRON_ALLOW_MULTI_INSTANCE` escape hatch:

```bash
# Bypass the single-instance lock for this one run (dev only).
ELECTRON_ALLOW_MULTI_INSTANCE=1 pnpm dev
```

This makes the process skip the lock entirely (it logs
`ELECTRON_ALLOW_MULTI_INSTANCE=1 — 单实例锁已禁用` on boot). Use it only to get
unblocked — the proper fix is to kill the orphaned electron process (Task Manager
→ `electron.exe`, or `taskkill /F /IM electron.exe`) and then run `pnpm dev`
normally without the env var. Restarting Windows also clears it.

The env var is read at line 50 of `index.ts` (`allowMulti`), before
`app.requestSingleInstanceLock()`, so it must be set in the environment that
launches `pnpm dev` — not in renderer code.
