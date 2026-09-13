# Operations

How **AI待办** behaves on real hardware, how to recover from
problems, and where to look when things go wrong. This document
covers *runtime* concerns only; the structural picture is in
[`docs/architecture.md`](./architecture.md).

## Logging

Logs go to:

- stdout in dev (terminal that launched the app),
- `${userData}/todo-list.log` always (no built-in rotation;
  the file is appended to via `appendFileSync` from
  `src/main/logger.ts`).

The threshold defaults to `info`. To debug:

```ts
import { logger } from './logger';
logger.setThreshold('debug');
```

Phase timings written by `src/main/startup-state.ts` show up as
`startup[core]: <label> @ <Nms>` / `startup[ai]: <label> @ <Nms>` lines
on boot, and are the first place to look when a cold start feels
slow.

## Storage locations

Electron resolves `app.getPath('userData')` against the
`APP_USER_MODEL_ID` declared in `src/shared/constants.ts`
(`com.todolist.app`). On a typical machine:

| Platform | `userData` (= config + log) | Default `dataDir` (= DB + files) |
| -------- | ---------------------------- | -------------------------------- |
| Windows  | `%APPDATA%/todo-list`        | `%APPDATA%/../.todo-list`        |
| macOS    | `~/Library/Application Support/todo-list` | `~/.todo-list`         |
| Linux    | `~/.config/todo-list`        | `~/.todo-list`                    |

The data directory can be moved via
`settings.chooseDataDir` in the Settings panel; the config path
in `userData` stays stable so it survives a data-dir relocation.

Inside the data directory:

```
.todo-list/
├── db.sqlite                  SQLite database (WAL + shm files alongside)
├── db.sqlite-wal              write-ahead log
├── db.sqlite-shm              shared memory index
├── config.json                NOT HERE — config lives in userData. (Legacy
│                              mention below.)
├── todos/
│   └── {storage_dir}/
│       ├── todo.json
│       ├── progress.html
│       ├── {noteSlug}.md
│       ├── {drawingSlug}.excalidraw
│       ├── thumbs/{drawingId}.thumb.png
│       └── attachments/{attachmentId}-{filename}
├── drawings/                  (per-drawing files mirrored for older
│                              tasks; new tasks use the per-task
│                              `drawings/` subdir)
├── inbox-attachments/         pending clipboard / drag-drop stash
└── dsh-sessions/              AI conversation JSONL history
```

Inside the user directory:

```
todo-list/                    ← userData, app-id-stamped
├── config.json                SettingsStore output (apiKey lives here)
└── todo-list.log              logger output
```

> **Why both `userData/config.json` and `dataDir/`.** Settings
> (provider, API key, hotkey, theme, custom providers) live in
> `userData` so the data directory can be relocated without losing
> credentials. The DB and the per-task files live in the data
> directory so they can be backed up as one unit. The previous
> architecture doc claimed `config.json` sat inside the data
> directory — that has not been true since the v15 layout split.

## Backups

The DB is the source of truth; the per-task files are derived
projections (see ADR-001). To back up: stop the app, copy the
entire data directory. Restore: copy back, restart. A running
copy of the app will pick up the moved data directory on the
next launch (the path is read from `config.json` at boot).

The config file in `userData` is the only piece that lives
elsewhere; back it up separately if you also want to preserve
provider credentials and capture hotkey.

## Auto-update

`electron-updater` checks GitHub Releases on launch. A new
version emits `app:update-available` to the renderer; the user
can trigger the download from the settings pane; on completion
the renderer gets `app:update-downloaded` and can "Restart to
install".

If a release breaks on first boot, downgrade by replacing the
installed `out/` directory with a known-good build and relaunching.
The data directory survives the swap.

## Performance

The hot path is the task list view. It pulls from the FTS5 +
`todos` tables; the WHERE clauses are index-friendly on
`(status, due_at)` and the tag filter is a JOIN on the
`todo_tags` association table. `TodoRepo.list` excludes deleted
tasks unconditionally and excludes archived tasks unless the
filter opts in.

For very large libraries (currently no `react-window` switch —
the list renders all rows) the cold path is dominated by DSH boot.
See `startup[ai]` log lines and ADR-004.

## Known limitations

- The capture window does not HMR. Restart it manually when
  iterating on `src/renderer/capture.tsx`.
- The JSON-RPC bridge uses a Unix socket which means it only works
  on the same machine. Remote access requires exposing the socket
  via the user's own forwarding; Windows named pipes cannot be
  shared cross-machine. Use the IPC surface from another
  renderer if you need cross-window control.
- The JSON-RPC bridge is OFF by default (SEC-01). To enable it,
  open 设置 → 外部访问 → 「外部脚本 / 插件访问」 → 启用，
  copy the displayed capability token, then send it on the
  first line of every connection as `auth: "<token>"`. Toggling
  takes effect on the next application launch. The bridge log
  line `bridge: <phase> ...` (under `${userData}/todo-list.log`)
  is the source of truth for "who connected when and how many
  calls they made"; it never includes params or the token.
- To attach a redacted diagnostics snapshot to a bug report,
  open 设置 → 关于 → 「导出诊断包…」(OBS-01). The resulting
  JSON file contains app / OS / schema versions, startup state,
  provider name + model (no key), task counts, data-dir sizes
  and the last ~32 KiB of the log file (with paths / keys /
  emails scrubbed). It does NOT include task bodies, drawing
  scenes, AI conversations or attachments.
- The 设置 → 健康 pane (QUALITY-01) runs six deterministic rules
  every time `app:data-changed` fires. The pane surfaces issues
  with severity ordering (blocker → warn → info). It is
  read-only by design — automatic repair is intentionally out of
  scope to keep the layer AI-free and testable.
- The command palette (Cmd/Ctrl-K, SEARCH-01) lets you multi-select
  TODO results and apply bulk actions without leaving the keyboard:
  status changes, priority bumps, "加入今日", or push the selection
  as AI context for the next prompt. All bulk actions reuse
  `todo.batchUpdate` — there is no second write path.
- DSH boot is best-effort: a failed boot surfaces as
  `ai.ask → dsh_unavailable` and is visible in the AI pane as a
  non-blocking banner. The rest of the app stays usable.
- The splash waits for the LOCAL DSH bootstrap (Cordis boot +
  adapter + tools + persistence + listeners) to reach a terminal
  state before mounting the renderer (STARTUP-DSH-001). The
  warm-up performs no network requests, no API-key checks, no
  `/models` calls — those live in the `ai.ask` per-request
  path. If the user sees the splash stuck on "准备 AI 助手…"
  for more than ~3 s on a cold machine, that's the
  `@deepseek-ai/dsh-app-boot` import + cordis.yml parse; the
  `startup[ai]` log lines in `${userData}/todo-list.log` carry
  the per-phase timing for diagnosis.
- Orphan-session migration runs synchronously inside the boot
  body AFTER `warmupDshRuntime` resolves, reusing the live
  runtime's persistence facade. There is no second Cordis
  boot for migration; the `boot('todo-list-migrate', ...)`
  path that existed before STARTUP-DSH-001 is gone.
- The renderer preload runs with `sandbox: false`. This is
  documented in `createMainWindow()` and is required by the inline
  splash script in `index.html`.
