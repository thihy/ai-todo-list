# Changelog

All notable changes to todo-list are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
