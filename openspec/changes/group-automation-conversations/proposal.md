## Why
Each automation execution creates a separate conversation. A flat history becomes noisy and hides the relationship between runs.

## What Changes
- Automatically group run conversations by stable automation ID.
- Derive group names and existence from the automation catalog; prohibit independent group edits and deletion.
- Keep conversations after automation deletion, under ungrouped history.
- Backfill historical ownership from explicit saved run references.

## Capabilities
### New Capabilities
- `automation-conversation-groups`: lifecycle-bound grouping of execution chats.

## Impact
SQLite migration 25, conversation repository and IPC projection, automation runner and history UI.
