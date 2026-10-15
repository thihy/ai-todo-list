# Proposal

## Why
First-time AI drawing fails because canvas readiness is published before Excalidraw supplies its API. The editor also remounts after scene refreshes and owns a window-wide save shortcut, risking focus and keyboard interference.

## What Changes
- Publish readiness only after the live drawing API is available.
- Apply external scene refreshes without recreating the editor and isolate save shortcuts to the canvas.
- Cancel stale autosaves, preserve input focus, and report persistence failures accurately.
- Use the installed Excalidraw updateScene contract.

## Capabilities
### New Capabilities
- `drawing-lifecycle`: Reliable AI drawing admission and editor input isolation.
### Modified Capabilities
None.

## Impact
Excalidraw editor, scene application and loading, runtime dependency wiring, unit tests and live isolated-profile verification.
