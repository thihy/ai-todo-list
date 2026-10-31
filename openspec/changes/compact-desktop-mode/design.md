# Design
Persisted floating visibility is restored after core startup, independently of main-window minimization or restoration. The personal avatar, tray and Windows taskbar task menus toggle the persisted state. Manual close hides the floating window. General Settings has no floating configuration; the floating window retains its local display menu. Every reopening restores saved geometry and transparency preferences. The title-bar compact entry is removed.

## Context
The app owns a single main window and a shared IPC task API with broadcasts to all windows. There is no existing compact route. See proposal.md for motivation.

## Goals / Non-Goals
**Goals:** reuse task operations, retain main-window bounds, show as many complete rows as the user-selected height permits, recover from load errors, handle midnight changes.
**Non-Goals:** desktop-shell embedding, new task storage, automatic startup in compact mode.

## Decisions
- Use a dedicated 240px frameless always-on-top window independent of the main window. Default content height is 172px, minimum height is 92px. A ResizeObserver measures available list height and renders floor(height / 26) complete rows from the full sorted task set. The list never scrolls; task updates never resize the window. Reusing and resizing the main window would require reversible minimum sizes and caption overlay changes.
- Render a separate compact entry using the same preload and task API. Use a pure selection function for today/due ordering. Subscribe directly to data broadcasts and refresh on focus and minute ticks.
- Window-control IPC is presentation-only. Completion delegates to existing todo.update.
- Native window borders allow manual resizing. Native will-resize disables automatic height, while move/resize events debounce preference writes to the existing SettingsStore. Always-on-top is applied natively. The native window stays transparent at opacity 1; independent renderer regions apply the configured transparency to inactive content and half that transparency to the title. Hover makes only the title opaque; activation makes both regions opaque. Inactive content passes mouse input through, while the title remains clickable for activation. Preferences are normalized before saving and restored with bounds clamped to the available screen.
- Style compact rows and import/link dialogs using existing emerald/graphite tokens, semantic controls and visible keyboard focus.

## Risks / Trade-offs
- Always-on-top can obscure other apps → small draggable window and immediate full-mode return.
- Monitor removal can strand saved coordinates → clamp bounds to the current work area on entry.
- Async requests can resolve out of order → ignore stale loads and disable duplicate completion.

## Migration Plan
No data migration. Remove the compact controller and entry point to roll back.
