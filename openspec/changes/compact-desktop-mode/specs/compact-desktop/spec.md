## Purpose

Keep actionable tasks visible in a small desktop window while users work in other applications, without duplicating task storage or task behavior.

## ADDED Requirements

### Requirement: Inactive pass-through and regional transparency
The inactive floating window SHALL pass pointer input through its content while retaining a reachable title strip. The content SHALL use the configured transparency, and the title SHALL use half that transparency. Hovering the title SHALL make only the title opaque. Activating the window SHALL make both regions opaque and disable pass-through; losing focus SHALL restore the inactive state.

#### Scenario: Sixty percent transparency
- **WHEN** the configured transparency is 60 percent and the window is inactive
- **THEN** the content opacity is 0.4 and title opacity is 0.7
- **AND** hovering the title changes only title opacity to 1
- **AND** activating the window changes both opacities to 1 and disables mouse pass-through

### Requirement: Compact floating task surface
The app SHALL automatically show a draggable always-on-top compact window when the main window is minimized, displaying at most five active tasks, without a title-bar compact button or stealing focus. The main window SHALL remain available in the taskbar; restoring it SHALL keep the compact window visible. The tray shortcut remains available. It SHALL place local-today tasks first, then sort by ascending due date with undated tasks last and recent updates as a tie-breaker. Done, cancelled, archived and deleted tasks SHALL be excluded.

#### Scenario: Mixed task list
- **WHEN** compact mode opens with more than five eligible tasks
- **THEN** only the first five in the defined order appear in a window with 240px content width, no wider than 256 pixels including native borders, and at most 190 pixels tall; fewer tasks reduce its height

#### Scenario: Minimize and restore
- **WHEN** the main window is minimized and later restored from the taskbar
- **THEN** compact mode automatically appears and stays visible on restore, reusing one window on repeated minimization; manual close disables it until re-enabled in Settings → General
- **AND** manually disabling the floating window before its content is ready SHALL prevent a delayed window from appearing

### Requirement: Shared actions and window lifecycle
Compact mode SHALL use the existing task API to complete tasks and SHALL refresh on task changes. Users SHALL be able to restore the main window or open a task's details. Closing compact mode SHALL restore the main window. Repeated entry SHALL reuse a single window.

#### Scenario: Complete and restore
- **WHEN** a user completes a compact task and opens another task
- **THEN** completion is reflected in both windows and the main window opens the selected task

#### Scenario: Empty or failed list
- **WHEN** no actionable tasks exist or loading fails
- **THEN** the compact view displays an empty or retry state and keeps the return action accessible

### Requirement: User controlled geometry and transparency
The compact window SHALL be user-resizable with a minimum size of 200 by 64 pixels and SHALL float above other windows by default. A window settings menu SHALL let users toggle floating and choose transparency between 0 and 60 percent. Geometry, opacity and floating preferences SHALL persist across reopening. Manual resizing SHALL override automatic height until users restore compact sizing.

#### Scenario: Preserve a resized translucent window
- **WHEN** a user resizes the window, selects 40 percent transparency and reopens it
- **THEN** the chosen geometry and transparency remain, and task updates do not shrink the window
