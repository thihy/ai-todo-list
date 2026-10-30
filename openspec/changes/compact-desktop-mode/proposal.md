# Proposal

## Why

Users need to keep their next actions visible while working in other desktop apps without occupying the full task workspace.

## What Changes

- Add an always-on-top compact desktop window with at most five actionable tasks.
- Order today's planned tasks first, then earliest due date; omit completed, cancelled, archived and deleted tasks.
- Offer compact mode from the main title bar and tray, and return to the main window or a task's detail.
- Allow quick completion using the existing task API and synchronize both windows.

## Capabilities

### New Capabilities
- `compact-desktop`: Compact floating task list and window switching.

### Modified Capabilities
None.

## Impact

Electron window lifecycle and tray, renderer entry and compact view, shared application IPC. No new database tables or MCP tools.
