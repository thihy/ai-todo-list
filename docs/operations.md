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
- The splash no longer waits for the LOCAL DSH bootstrap
  (STARTUP-AI-ASYNC-002 supersedes STARTUP-DSH-001's gate). The
  new splash exit condition is `core.status === 'ready'` only;
  the DSH cold-boot happens in the background behind the
  AIPane "正在启动 AI 助手…" overlay. On a cold Windows
  install the user lands in the task list within ~1 s of core
  becoming ready while DSH continues to warm up — measured at
  ~22 s before this change, of which the splash used to wait
  for the entire duration. If the boot ever flags Windows
  "未响应" again the relevant evidence is the
  `startup[ai]: DSH boot …` log line in
  `${userData}/todo-list.log`, which records both the
  sub-phase timing AND the main-process event-loop latency
  (max / p99 / p95 / mean / samples) collected via
  `node:perf_hooks.monitorEventLoopDelay`. A `max > 5000ms`
  in that line is the signal that the boot is blocking the
  IPC handler queue for seconds at a time and needs the
  utility-process / worker-thread isolation follow-up. The
  warm-up itself still performs no network requests, no
  API-key checks, no `/models` calls — those live in the
  `ai.ask` per-request path.
- Orphan-session migration runs synchronously inside the boot
  body AFTER `warmupDshRuntime` resolves, reusing the live
  runtime's persistence facade. There is no second Cordis
  boot for migration; the `boot('todo-list-migrate', ...)`
  path that existed before STARTUP-DSH-001 is gone.
- The renderer preload runs with `sandbox: false`. This is
  documented in `createMainWindow()` and is required by the inline
  splash script in `index.html`.
- Manual backup creation lives in 设置 → 数据 → 数据备份
  (REL-01 MVP-1). The button copies the live SQLite DB + the
  durable file projections (todos/ + drawings/ + attachments/)
  into a unique timestamped subfolder under a user-chosen
  destination. DSH session logs are excluded (regenerable +
  contain user prompts). Restore + delete + auto-scheduling
  are scoped for the next iteration. The on-disk manifest
  (`<backup>/manifest.json`) carries no absolute paths and no
  API keys so it's safe to share when filing a bug report.
- Auto-update is wired through `electron-updater` against the
  GitCode releases feed declared in `package.json → build.publish`
  (string-URL shorthand for the BYO-generic server, URL
  `https://gitcode.com/ai-sea/ai-todo-list/releases/latest`).
  The auto-check fires 5 s after the renderer's first paint so
  it never races with the splash or the STARTUP-AI-ASYNC-002
  boot window. dev mode (`!app.isPackaged`) short-circuits to
  a no-op so `pnpm dev` doesn't accidentally overwrite the
  developer's out/. Release flow (manual — GitCode releases are
  not an S3-compatible store, so electron-builder's automatic
  `--publish always` cannot upload assets there): build the
  binary locally (`pnpm dist:win` — `publish` is a string URL
  in v26 schema, so the validator accepts it; the build itself
  defaults to `--publish never` and never tries to PUT); then
  draft a GitCode release tagged `v<version>` (e.g.
  `v1.0.0-rc3`); upload the asset `ai-todo-list-Setup-1.0.0-rc3.exe`
  (asset name is governed by the `artifactName` template) plus
  a hand-written `latest.yml` (electron-updater's diff
  manifest format — `version`, `files[].url`, `sha512`,
  `releaseDate`, `size`) at the same release's download root
  so the autoUpdater can fetch it on next startup. To avoid
  hand-writing the YAML, run `node
  scripts/generate-latest-yml.mjs <path-to-installer-exe>`
  after `pnpm dist:win` — it hashes the binary (SHA-512
  base64), emits the right manifest filename (`latest.yml` /
  `latest-mac.yml` / `latest-linux.yml` per platform), and
  prints the upload instructions to stdout. The
  renderer side lives in `SettingsModal → 关于 → 更新`: a
  status line ("已是最新版本" / "发现新版本 X，下载中…" /
  "已下载，重启后生效"), a "检查更新" button, and a
  "立即重启更新" button that appears once the binary is
  staged. Users on dev builds see "开发模式下不可用" instead of
  an enabled button. The updater module
  (`src/main/updates/updater.ts`) keeps internal state on a
  per-process singleton; reload / second window reuse the
  same runtime via the existing `app.renderer.ready`
  handshake.
