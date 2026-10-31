# Proposal

## Why
Current AI drawing is mostly batch generation: it appends new shapes or overwrites a stored scene. It cannot reliably help users edit their live selection while preserving concurrent manual changes. The user requested an engine-owned MCP interface consumed by DSH.

## What Changes
- Expose the current embedded drawing engine through a local MCP service, rather than operating a separate remote whiteboard.
- Read the live scene, selection, viewport and revision, including unsaved edits.
- Apply bounded element operations to existing shapes, labels and connectors with conflict detection, idempotency and explicit acknowledgement.
- Support one-step restoration of an AI edit and actual image snapshots for visual feedback.
- Connect DSH through an MCP client adapter; preserve existing permission review and recoverable tool-error behavior.

## Capabilities
### New Capabilities
- `live-drawing-mcp`: live canvas context, incremental edits and reversible engine operations over MCP.
### Modified Capabilities
None. Existing drawing generation and file compatibility remain available during migration.

## Impact
DrawingCanvasHost, ExcalidrawEditor, shared drawing IPC, a local MCP transport and DSH client integration. MCP SDK dependency/client availability must be verified before selecting an adapter. Reuse TaskDirectoryStore and existing drawing persistence; no new drawing database or task-storage layout.
