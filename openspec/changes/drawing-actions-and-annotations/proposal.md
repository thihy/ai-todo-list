# Proposal

## Why
Users need selection-based AI annotations they can batch, complete access to native Excalidraw actions, and a usable progress editor outside the small floating todo window. The legacy drawing_read tool invites file/JSON fallback and the current semantic surface rejects bound-text alignment arguments.

## What Changes
- Expose the complete installed native action registry to AI through a version-checked engine bridge; execute actual native actions, preserve permissions, acknowledge actual outcomes and retain conflict/idempotency protection.
- Remove model-facing drawing_read and prohibit file/scene-JSON fallback for drawing operations.
- Support validated bound-text creation/alignment in semantic edits.
- Add a selection-anchored annotation composer and editable pending list with one batch submission into the existing assistant queue, including real element references and no task-create intent.
- Move compact-window progress entry to its own appropriately sized editor window so it cannot obscure/crop the task list.

## Capabilities
### New Capabilities
- `drawing-actions-and-annotations`: native action coverage, selected-element annotations and independent compact progress entry.
### Modified Capabilities
None.

## Impact
Renderer engine and build bridge, main DSH tools/permissions, typed IPC, AI external submission, compact window management and relevant tests. Retain task directory/file persistence; no drawing DB tables.
