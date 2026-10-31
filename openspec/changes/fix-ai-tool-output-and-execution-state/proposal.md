# Why
Tool rows conflate empty output and absent result records. Renderer-only execution state can report completion or cancellation while main or native jobs still run. Internal todo_write lacks a localized label, and floating subtasks need explicit coverage and identity.

# What Changes
- Distinguish empty, missing and stopped outputs and expose missing-result diagnostics.
- Localize todo_write as the AI execution plan, separate from user tasks.
- Add revisioned main execution snapshots, scoped background-job status and acknowledged cancellation; recover status after reload.
- Show active floating subtasks independently of completed parents.
- Replace the clipped floating task overlay menu with a complete native context menu.

# Capabilities
## New Capabilities
- `ai-execution-state`: authoritative execution synchronization.
## Modified Capabilities
None.

# Impact
Shared IPC, preload, DSH runtime, AI pane, tool rows and compact view. No task storage change.
