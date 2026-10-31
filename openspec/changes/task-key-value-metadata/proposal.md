## Why
Tasks need custom fields such as external IDs, customer names and source information without expanding the fixed task schema for every use case.
## What Changes
- Add validated string KV metadata to tasks with empty-object legacy default.
- Provide a task details editor and native AI read/write access.
- Include metadata in task snapshots and normal DB backups.
## Capabilities
### New Capabilities
- `task-metadata`: persistent custom task KV values.
## Impact
SQLite migration 26, shared task API, task repository, detail editor and DSH tools.
