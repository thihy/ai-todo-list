## Purpose

为整个应用提供安全的 Electron 桌面运行时:主进程 / preload / 渲染进程分层隔离、严格的 IPC 通道、本地优先的数据持久化、跨平台打包与自动更新。

## ADDED Requirements

### Requirement: Process isolation
The system MUST run with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` for every renderer window, and MUST expose capabilities exclusively through a typed preload bridge.

#### Scenario: Renderer cannot access Node APIs
- **WHEN** a renderer attempts `require('fs')`
- **THEN** the call fails because Node integration is disabled
- **AND** only methods exposed via the preload bridge are reachable

### Requirement: Typed IPC surface
The system SHALL define an explicit IPC schema (channel name, request type, response type) for every capability crossing the process boundary; unknown channels MUST be rejected.

#### Scenario: Unknown channel rejected
- **WHEN** the renderer invokes an IPC channel not declared in the schema
- **THEN** the main process rejects the call with an "unknown channel" error
- **AND** the error is logged with the channel name

### Requirement: Local-first storage
The system SHALL persist all user data (SQLite database, Markdown files, Excalidraw files, AI provider config) under `~/.todo-list/` (or platform equivalent) and MUST operate fully offline excluding AI features.

#### Scenario: Offline launch
- **WHEN** the app is launched with no network
- **THEN** the existing data is loaded and the app is fully usable except for AI features
- **AND** an "offline" indicator is shown in the status bar

### Requirement: Cross-platform packaging
The system SHALL build distributable artifacts for Windows (NSIS via electron-builder), macOS (DMG), and Linux (AppImage) — the exact targets declared in `package.json → build.win/mac/linux`. No MSI, no `.deb` in the current configuration.

#### Scenario: Build Windows installer
- **WHEN** `pnpm run dist:win` is run on a Windows host
- **THEN** an NSIS installer `dist/ai-todo-list-Setup-*.exe` is produced

### Requirement: Auto-update channel
The system SHALL check for updates on startup against the GitCode Releases feed declared in `package.json → build.publish` (`https://gitcode.com/ai-sea/ai-todo-list/releases/latest`) and SHALL allow the user to disable updates entirely in Settings. When updates are enabled and a new version is available, the renderer surfaces an "Restart to update" prompt; the actual swap happens on the next launch with the user's consent.

#### Scenario: User accepts update
- **WHEN** an update is available and the user clicks "Restart to update"
- **THEN** the app applies the update, restarts, and launches the new version

### Requirement: External agent interface (JSON-RPC bridge)
The system SHALL expose `TodoListSdk` over JSON-RPC 2.0 on a Unix socket (`/tmp/todo-list.sock`) or Windows named pipe (`\\.\pipe\todo-list`) — line-delimited, one JSON object per line. The bridge MUST be disabled by default; enabling it requires a capability token returned in Settings and accepted on the first line of every connection as `auth: "<token>"`. Toggling the flag takes effect on the next application launch.

#### Scenario: External agent creates TODO
- **WHEN** an external script sends `{"jsonrpc":"2.0","id":1,"method":"todo.create","params":{...}}` over the socket with a valid token
- **THEN** the new TODO appears in the UI within 1 second
- **AND** the response returns the new TODO id

#### Scenario: Disabled by default
- **WHEN** the user has not enabled the bridge in Settings
- **THEN** no socket or named pipe is listening on the platform-specific path
- **AND** `${userData}/todo-list.log` contains no `bridge:` lines