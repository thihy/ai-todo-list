# Tasks

## 1. Window and data flow
- [x] 1.1 Add compact window lifecycle and shared IPC; verify singleton entry, always-on-top bounds, return and detail navigation in Electron tests.
- [x] 1.2 Add today/due selection with unit coverage for exclusion, ordering, limits and local dates.

## 2. Interface
- [x] 2.1 Implement compact rows, completion, broadcasts and empty/error states; verify live updates in Electron tests.
- [x] 2.2 Restore floating visibility on startup independently of minimization; expose avatar, tray and taskbar show/hide actions and remove General Settings configuration; verify persistence, manual close and singleton reentry in Electron tests.
- [x] 2.3 Restyle import dialog and use an import icon; distinguish local/web link forms; verify interactions and screenshot layout.

## 3. Integration
- [x] 3.1 Run typecheck, relevant unit tests, build, Electron scenarios and OpenSpec validation.

## 4. User window preferences
- [x] 4.1 Enable resizing and persistent native-window preferences; verify opacity, manual-size retention, defaults and reload in unit and Electron tests.
- [x] 4.2 Add a compact settings menu and document floating, transparency and compact-size reset; verify typecheck, build and specification validation.
- [x] 4.3 Apply independent inactive content/title transparency, title hover opacity and focus-driven mouse pass-through; verify 60% content transparency, 30% title transparency, hover and activation in Electron tests.
- [x] 4.4 Align title icons, add task bullets and render height-driven complete rows without scrolling or fixed row caps; verify expansion beyond six, shrink behavior and persisted preferences in Electron tests.
