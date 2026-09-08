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
The system SHALL persist all user data (SQLite database, Markdown files, Excalidraw files, AI provider config) under `~/.thihy-todolist/` (or platform equivalent) and MUST operate fully offline excluding AI features.

#### Scenario: Offline launch
- **WHEN** the app is launched with no network
- **THEN** the existing data is loaded and the app is fully usable except for AI features
- **AND** an "offline" indicator is shown in the status bar

### Requirement: Cross-platform packaging
The system SHALL build distributable artifacts for Windows (NSIS / MSI), macOS (DMG), and Linux (AppImage / deb) using electron-builder.

#### Scenario: Build Windows installer
- **WHEN** `pnpm run dist:win` is run on a Windows host
- **THEN** an NSIS installer and a portable EXE are produced under `dist/`

### Requirement: Auto-update channel
The system SHALL check for updates on startup against a configured feed (default: GitHub Releases) and apply updates on next launch with the user's consent.

#### Scenario: User accepts update
- **WHEN** an update is available and the user clicks "Restart and update"
- **THEN** the app applies the update, restarts, and launches the new version

### Requirement: External agent interface (DSH ACP / SDK)
The system SHALL expose the DSH ACP and SDK profiles (`@deepseek-ai/dsh-acp-app` and `@deepseek-ai/dsh-sdk-app`) over stdio or local socket inside the same main process, allowing external AI agents to list, read, create, and update TODOs through the same DSH tools that the in-app agent uses.

#### Scenario: External agent creates TODO
- **WHEN** an external AI agent connects via ACP or SDK and invokes the `todo_create` tool
- **THEN** the new TODO appears in the UI within 1 second
- **AND** the call returns the new TODO id