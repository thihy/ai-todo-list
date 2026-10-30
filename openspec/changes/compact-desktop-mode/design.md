# Design

## Context
The app owns a single main window and a shared IPC task API with broadcasts to all windows. There is no existing compact route. See proposal.md for motivation.

## Goals / Non-Goals
**Goals:** reuse task operations, retain main-window bounds, show five dense rows, recover from load errors, handle midnight changes.
**Non-Goals:** desktop-shell embedding, new task storage, automatic startup in compact mode.

## Decisions
- Use a dedicated lazy-created 240px frameless always-on-top window; hiding the main window preserves its layout and state. Single-line 26px task rows keep five tasks around 170px tall; fewer tasks shrink the window. Reusing and resizing the main window would require reversible minimum sizes and caption overlay changes.
- Render a separate compact entry using the same preload and task API. Use a pure selection function for today/due ordering. Subscribe directly to data broadcasts and refresh on focus and minute ticks.
- Window-control IPC is presentation-only. Completion delegates to existing todo.update.
- Native window borders allow manual resizing. Native will-resize disables automatic height, while move/resize events debounce preference writes to the existing SettingsStore. The native menu applies window opacity and always-on-top directly; preferences are normalized before saving and restored with bounds clamped to the available screen.
- Style compact rows and import/link dialogs using existing emerald/graphite tokens, semantic controls and visible keyboard focus.

## Risks / Trade-offs
- Always-on-top can obscure other apps → small draggable window and immediate full-mode return.
- Monitor removal can strand saved coordinates → clamp bounds to the current work area on entry.
- Async requests can resolve out of order → ignore stale loads and disable duplicate completion.

## Migration Plan
No data migration. Remove the compact controller and entry point to roll back.
