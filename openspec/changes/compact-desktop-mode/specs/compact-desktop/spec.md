## Purpose

Keep actionable tasks visible in a small desktop window while users work in other applications, without duplicating task storage or task behavior.

## ADDED Requirements

### Requirement: Compact floating task surface
The app SHALL offer a draggable always-on-top compact window from the title bar and tray, displaying at most five active tasks. It SHALL place local-today tasks first, then sort by ascending due date with undated tasks last and recent updates as a tie-breaker. Done, cancelled, archived and deleted tasks SHALL be excluded.

#### Scenario: Mixed task list
- **WHEN** compact mode opens with more than five eligible tasks
- **THEN** only the first five in the defined order appear in a window with 240px content width, no wider than 256 pixels including native borders, and at most 190 pixels tall; fewer tasks reduce its height

### Requirement: Shared actions and window lifecycle
Compact mode SHALL use the existing task API to complete tasks and SHALL refresh on task changes. Users SHALL be able to restore the main window or open a task's details. Closing compact mode SHALL restore the main window. Repeated entry SHALL reuse a single window.

#### Scenario: Complete and restore
- **WHEN** a user completes a compact task and opens another task
- **THEN** completion is reflected in both windows and the main window opens the selected task

#### Scenario: Empty or failed list
- **WHEN** no actionable tasks exist or loading fails
- **THEN** the compact view displays an empty or retry state and keeps the return action accessible
