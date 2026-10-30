# Proposal

## Why
The built-in AI assistant supports standard skills and authorized external files but cannot execute recurring instructions. Users need persistent schedules that reuse the same AI execution and permission checks as chat.

## What Changes
- Add calendar, interval and five-field Cron triggers with explicit timezones.
- Add persistent automation management, pause/resume, manual execution and run history in settings.
- Reuse the existing AI request path and real conversations; never elevate permissions.
- Skip missed occurrences after downtime and prevent overlapping runs.

## Capabilities
### New Capabilities
- `ai-automations`: Persistent recurring AI instructions and execution history.
### Modified Capabilities
None.

## Impact
Main-process scheduler and persistence, AI handler, IPC/preload API, settings UI and focused tests. Existing task metadata is unchanged. Rollback removes scheduler startup and its UI; the automation data can remain inert.
