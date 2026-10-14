# Proposal

## Why
During generation users can only draft or stop. They need to queue follow-ups and guide an active task without discarding its execution.

## What Changes
- Add ordered editable/removable message queues with attachment snapshots and failure/stop pause.
- Use native DSH steering with invocation validation and queue fallback.
- Map Enter/Ctrl+Enter to queue/steer with a persisted swap setting.
- Preserve the active pane while collapsed and hide synthetic skill catalog messages.

## Capabilities
### New Capabilities
- `message-queue-and-steer`: Ordered follow-up delivery and nearest-step steering.
### Modified Capabilities
None.

## Impact
Renderer composer, pane lifecycle and scheduling, DSH runtime, typed IPC/preload, settings UI and store, history folding, docs and tests.
