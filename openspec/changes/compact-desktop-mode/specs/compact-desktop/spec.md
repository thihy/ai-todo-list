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
The app SHALL show a draggable always-on-top compact window whenever its persisted visibility is enabled, including startup, without stealing focus. Main-window minimization and restoration SHALL NOT control floating visibility. The personal avatar menu, system tray context menu and Windows taskbar task menu SHALL provide 显示悬浮窗 or 隐藏悬浮窗 according to the current state. General Settings SHALL NOT expose floating-window configuration. Each reopening SHALL restore saved geometry, transparency and always-on-top values. It SHALL place local-today tasks first, then sort by ascending due date with undated tasks last and recent updates as a tie-breaker. Done, cancelled, archived and deleted tasks SHALL be excluded. The list SHALL display only the complete task rows fitting the available height, without a scrollbar or fixed task-count cap. Each task SHALL have a small decorative bullet. Title actions SHALL use consistently sized, centered icons.

#### Scenario: Mixed task list
- **WHEN** compact mode contains more tasks than fit the current window height
- **THEN** it displays complete rows in the defined order without scrolling
- **AND** increasing the height reveals more tasks, including more than six when space permits, without automatically shrinking on task updates

#### Scenario: Minimize and restore
- **WHEN** the main window is minimized and later restored from the taskbar
- **THEN** compact visibility remains unchanged, reusing one window; manual close hides it until re-enabled from the avatar, tray or taskbar menu
- **AND** manually disabling the floating window before its content is ready SHALL prevent a delayed window from appearing

### Requirement: Shared actions and window lifecycle
Compact mode SHALL use the existing task API to complete tasks and SHALL refresh on task changes. Users SHALL be able to restore the main window or open a task's details. Hiding compact mode SHALL leave main-window visibility unchanged. Repeated entry SHALL reuse a single window.

#### Scenario: Complete and restore
- **WHEN** a user completes a compact task and opens another task
- **THEN** completion is reflected in both windows and the main window opens the selected task

#### Scenario: Empty or failed list
- **WHEN** no actionable tasks exist or loading fails
- **THEN** the compact view displays an empty or retry state and keeps the return action accessible

### Requirement: User controlled geometry and transparency
The compact window SHALL be user-resizable with a minimum size of 200 by 92 pixels and SHALL float above other windows by default. A window settings menu SHALL let users toggle floating and choose transparency between 0 and 60 percent. Geometry, opacity and floating preferences SHALL persist across reopening. Task updates SHALL NOT change the window height. The compact-size reset SHALL restore a default content height of 172 pixels.

#### Scenario: Preserve a resized translucent window
- **WHEN** a user resizes the window, selects 40 percent transparency and reopens it
- **THEN** the chosen geometry and transparency remain, and task updates do not shrink the window
