# Proposal

## Why

Users need to keep their next actions visible while working in other desktop apps without occupying the full task workspace.

## What Changes

- Add an independent always-on-top compact desktop window with height-driven complete task rows and no scrollbar or fixed row cap.
- Order today's planned tasks first, then earliest due date; omit completed, cancelled, archived and deleted tasks.
- Offer show/hide actions from the personal avatar, tray and Windows taskbar menus; persist visibility independently of main-window minimization. Return to the main window or a task's detail from the floating window.
- Allow quick completion using the existing task API and synchronize both windows.

## Capabilities

### New Capabilities
- `compact-desktop`: Compact floating task list and window switching.

### Modified Capabilities
None.

## Impact

Electron window lifecycle and tray, renderer entry and compact view, shared application IPC. No new database tables or MCP tools.
