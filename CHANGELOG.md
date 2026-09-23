# Changelog

All notable changes to todo-list are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-rc7] - 2026-09-23

User-visible changes since `1.0.0-rc6`. Theme: ship-blocking packaging fix (DSH runtime was failing to boot from the packaged installer because 12 transitive DSH peer packages were never copied into `app.asar`), plus a small "open log dir" affordance for bug reporting.

### Added

- **「打开日志目录」button in 设置 → 关于.** Sits right below the existing "导出诊断包" button. Opens the `userData` directory (the parent of `todo-list.log`, which also contains the SQLite db and sessions cache) in the OS file manager via a new `app.openLogDir` IPC. One click instead of guessing the path.

### Fixed

- **DSH runtime boot failed after install with eight `Cannot find package '@deepseek-ai/...'` errors.** Root cause: `electron-builder` only copies packages listed under `package.json → dependencies` into `app.asar`; transitive resolution only matters for *resolution*, not for *packing*. The concrete DSH sandbox / fs / shell / subprocess / spill packages were on disk (and most made it into the asar), but their abstract peer packages — `dsh-sandbox`, `dsh-fs`, `dsh-shell`, `dsh-subprocess`, `dsh-spill` — and the concrete `dsh-pwsh-local` backend (referenced by `dsh-pwsh-sandbox`'s static import but never declared in its `package.json` deps) were not. Promoting all 12 to direct dependencies fixes it; no network resolution needed since they were already in the pnpm store. Log evidence in `%AppData%\AI待办\todo-list.log`: `failed to import loader entry fs-sandbox (@deepseek-ai/dsh-fs-sandbox): Cannot find package '@deepseek-ai/dsh-fs' imported from ...\dsh-fs-local\lib\index.js` (and 7 sibling variants).

## [1.0.0-rc6] - 2026-09-21

User-visible changes since `1.0.0-rc5`. Theme: DSH AI assistant graduates from a chat surface into a workspace-aware agent — fs / shell tools under a sandbox, configurable permission presets, and attachments that no longer bloat the session log.

### Added

- **DSH AI assistant gains fs + shell tools.** The agent can now read, write, search and execute inside `<rootDir>/.todo-list/dsh_workspace/`, with a path-guard that hard-rejects any attempt to escape the workspace. A `permissions` cap system gates destructive operations.
- **Permission presets.** The AI pane surfaces a preset selector (`auto` / `standard` / `restrictive` / …) so the user picks the safety knob before the session starts. Default preset is `auto` (powered by `@nanmicoder/dsh-auto-mode`).
- **Tool call description cards.** Tool invocations now render the model's intent (one-line summary) in the AIPane, so the user knows *why* before approving.
- **"加入今日" toggle in the task detail panel.** Mirrors the list-row glyph; clicking it flips the task's `planned_for` to today (or back) without going back to the list.
- **Runtime log-level switch.** Settings → 日志 now toggles the level (`debug` / `info` / `warn` / `error`) without a restart; effective immediately via a logger re-init.
- **AI composer attachments via workspace paths.** Files picked from the `+` button (or pasted into the central Composer) are copied into `<rootDir>/.todo-list/dsh_workspace/inbox/` with a `c-<convId>-<ulid>-<basename>` filename and a sidecar JSON index; the prompt embeds the absolute path instead of the file bytes. No more 256 KiB hard cap, no more `text-only` filter — any MIME, any size, any binary.
- **AI-side full-chain logging.** HTTP / turn / stream / chunk / failure all log to `${userData}/todo-list.log` so a stuck turn can be reconstructed from the log alone.

### Changed

- **AI composer session log volume drops sharply.** Per-attachment prompt bytes go from O(file size) to O(filename) — a 5 MB screenshot that used to add ~7 MB to `session.jsonl.zstd` now adds ~80 bytes (one path reference + header).
- **AIPane "Stop" semantics.** Stop now reliably cancels the in-flight turn rather than freezing the previous turn mid-tool.

### Fixed

- **AIPane stuck on Stop during a pending user question.** The user-questions / user-approval signal handler now correctly tears down pending listeners so Stop no longer hangs.
- **Boot crash from a circular-import TDZ in the new logger.** The async/await pattern that briefly shadowed the top-level import is removed.
- **Tool failures now stop the wheel** instead of silently looping, so the user gets a chance to recover rather than watching it retry.
- **Markdown editor view mode + font size restored** after the document reopens.
- **Task row active state** now shows a visible left-border accent (was rendering as `transparent` against dark backgrounds).
- **Updater ESM-mode `require` bug** and 5 pre-existing test flakes resolved.

## [1.0.0-rc5] - 2026-09-17

Aggregate entry capturing every user-visible change since the 0.1.0
baseline. The internal `rc1`/`rc2` tags were pre-release drafts and
were never published externally; `rc3`/`rc4`/`rc5` are the real
release markers. Compared with 0.1.0:

### Added

- **Splash + startup state machine.** A non-React splash paints before
  the bundle downloads; React mounts once `core.status === 'ready'`.
  Two independent components (`core`, `ai`) drive phased startup logs
  (`startup[core]`, `startup[ai]`) in `${userData}/todo-list.log`.
- **Subtask support.** Every task can declare a `parentId`; the repo
  rejects cycles, soft-delete cascades to the whole subtree, and the
  child list query (`TodoFilter.parentId`) backs the new sub-task UX.
- **5-tier priority.** Replaced the legacy "无" / four-tier scale with
  `very-low / low / medium / high / very-high` (required field; DB
  schema v18 migrates historical `'none'` rows to `'low'`).
- **Tag catalog in SQLite.** Tags now have a per-name colour registry
  (`tag_catalog`) with rename / merge / scan-cleanup; the legacy
  `settings.tags` field is imported once at boot and then ignored.
- **JSON-RPC bridge (SEC-01).** Off by default; when enabled, exposes
  `TodoListSdk` over Unix socket / Windows named pipe, guarded by a
  capability token (first line of every connection).
- **AI init-failure in-session retry (UX-01).** The AI pane now offers
  a "重试" button on `ai.status === 'failed'`; `SettingsModal` also
  auto-fires `app.startupRetry('ai')` when a provider / API key /
  custom-provider save corrects the configuration.
- **Task health check (QUALITY-01).** Read-only sweep exposed in
  设置 → 健康: surfaces orphan / stale / inconsistent rows with
  severity-ordered issues; no auto-repair.
- **Search command palette (SEARCH-01).** `Cmd/Ctrl+K` multi-select
  results, bulk priority / tag / date / status / "加入今日" /
  push-as-AI-context actions, all routed through `todo.batchUpdate`.
- **Exportable diagnostics bundle (OBS-01).** 设置 → 关于 →
  「导出诊断包…」 writes a redacted JSON snapshot (app / OS /
  schema versions, startup state, provider name + model only,
  task counts, data-dir sizes, last ~32 KiB of log) for bug
  reports.
- **Auto-update enable / disable toggle.** Per-user kill-switch in
  设置; default behaviour unchanged (checks the GitCode Releases
  feed declared in `package.json → build.publish`).
- **Collapsible 今日待办 / 全部任务 sections** (3fc84d1).
- **DSH warm-up behind the splash.** STARTUP-DSH-001 waits for the
  local Cordis boot to finish; STARTUP-AI-ASYNC-002 relaxes the gate
  to `core.status === 'ready'` only and runs DSH in the background
  behind an AIPane loading overlay — measured ~22 s cold-boot window
  on Windows is no longer blocking.
- **Bilingual README** (e6a4ceb): the top-level README now ships in
  English and 中文 side-by-side.
- **AGENTS.md + task-creation-and-storage.md** (51242a8): a fast
  contributor guide for AI coding agents and the authoritative
  task-creation / storage contract.
- **CodeGraph baseline for AI agents** (ff033a4): the `.codegraph/`
  index plus the mandatory `rg` cross-check workflow are documented
  in `docs/code-exploration.md`.
- **Architecture baseline doc** (98da613): `docs/architecture.md`
  describes the source-of-truth wiring (Current / Known issues /
  Target state) and links the ADRs.

### Changed

- **DSH integration is real.** The previous "in-process shim" has
  been replaced by the upstream `@deepseek-ai/dsh-*@0.1.5-rc.2`
  packages plus `@earendil-works/pi-ai`. `container.ts` returns a
  tiny eager `{ health, models }` handle; the real agent loop lives
  in `dsh-runtime.ts` and is built lazily on the first `ai.ask`.
  No call sites needed to change because every consumer goes through
  `DshContainer` / `getDshRuntime()`.
- **DSH LLM adapter** now wraps the upstream `PiAiAdapter` from
  `@deepseek-ai/dsh-llm-pi-ai` instead of hand-rolled OpenAI /
  Anthropic SSE parsers. Settings-driven provider / model selection
  covers `deepseek`, `openai`, `anthropic`, `ollama`, and `custom`.
- **AIPane tool-call rendering** gained an explicit lifecycle
  (`missing-call` / `missing-result` / `done` / `error` / `stopped`)
  and a JSON / plain text toggle for input & output.
- **JSON-RPC bridge** is the single external surface; streaming
  events still flow through `ai.ask` IPC for in-app consumers.
- **Cordis / DSH boot diagnostics**: `boot-probe.ts` records
  per-phase timings and event-loop latency histograms.

### Fixed

- AIPane: composer streaming, pane drag, new-conversation flow,
  history menu, smooth sticky "current question" banner, 14 px
  assistant markdown, auto-follow hook with sticky-to-bottom
  semantics, blank-bubble skip when assistant text is empty.
- Settings: 任务配色 — multiple presets with the same name can now
  be selected independently, and the built-in 「无 / 低」 presets
  share a colour.
- Inbox: attachments listed in upload order; 链接 / 附件 layout
  compacted.
- Distribution: declared DSH runtime deps, excluded sharp / ripgrep
  platform binaries not used on the target platform, pinned Windows
  platform binaries as `optionalDependencies`, repaired DSH runtime
  boot by listing transitive deps, forced the npmmirror Electron /
  electron-builder mirrors via `cross-env`, resolved `cordis.yml`
  via `process.resourcesPath`, made the IPC register idempotent.
- CSP now allows the `attachment:` scheme so pasted progress images
  load in the renderer.
- Settings save failures surface a toast instead of a silent
  success.
- `progress.md` save flow no longer races the per-write
  burst-merge window in `progress_log`.
- **Markdown editor view mode persists.** Toggling the 全屏 / 取消全屏
  on the task detail DocumentsView unmounts and remounts the whole
  editor tree (TodoEditorPane → FullscreenDoc), which used to drop
  the 编辑 / 预览 / 分屏 selection back to `编辑`. The mode is now
  persisted to `localStorage` (`todo-list.mdView`) so it survives both
  the fullscreen transition and an app restart.
- **Document MD preview no longer inherits the AI-chat font shrink.**
  Earlier the AIPane's 14 px assistant prose was implemented by
  re-pointing the global `--dsw-font-markdown-*` tokens in
  `gradient-shadow-text.css` `body { }` down to 14 px, which also
  shrank the MarkdownEditor preview used by DocumentsView. Reverted
  the global tokens to their figma defaults (16 px base, 24 / 22 /
  20 / 16 px for h1–h4) and restored the `.aipane__body` scoped
  override so only the chat stream stays at 14 px.

### Removed

- **In-process DSH shim** (the `bootShim()` / `loadRealDsh()` pair
  and the `tools.ts` registry). Replaced by `registerDomainTools`
  in `src/main/dsh/dsh-runtime.ts`.
- **Hand-rolled OpenAI / Anthropic SSE parsers** in
  `src/main/dsh/http.ts`. Replaced by the upstream `PiAiAdapter`.
- **Legacy flat-file storage layout** (v1). The `todos/<id>.md`
  flat layout was migrated to the per-task directory layout
  (`{storage_dir}/`) backed by `TaskDirectoryStore`.

## [0.1.0] - 2026-09-07

### Added
- Initial release: AI-native Electron TODO list built on DeepSeek Harness (DSH).
- Quick capture window (`Ctrl+Shift+T`) with global hotkey and tray menu.
- Markdown content per TODO with auto-history and one-click restore (kept to last 20 versions).
- Excalidraw drawings attached to TODO with thumbnail strip and bidirectional navigation.
- DSH in-process Cordis container with `todo.*` / `content.*` / `drawing.*` tools.
- Three-tier permission system: auto / notify+undo / block, surfaced via undo toasts.
- AI chat pane with streaming tokens, tool calls, and `ai:stream` events.
- Stats pane (totals, completion rate, AI spend).
- Single-instance lock, system tray, auto-updater (electron-updater + GitHub Releases).
- External JSON-RPC bridge over Unix socket / Windows named pipe.
- WCAG 2.2 AA contrast tokens (computed via Python — see `openspec/changes/todo-list-desktop/ui-wireframe.md`).
