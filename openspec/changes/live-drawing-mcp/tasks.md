## 1. Live drawing engine bridge
- [x] Add typed live context/query and acknowledgement IPC, including current selection, viewport, elements and revision; verify unsaved edits and mounted editor ownership.
- [x] Implement validated incremental element operations, existing-node connector binding, idempotency and conflict rejection; verify no partial application or unrelated-element loss.
- [x] Add actual-state persistence acknowledgement and bounded conflict-aware restoration checkpoints; verify save failure and reopen behavior.
## 2. MCP and DSH
- [x] Verify supported MCP SDK and native DSH client availability, then implement a real local MCP server/client path for the engine surface with lifecycle cleanup and access control.
- [x] Route DSH drawing edits through MCP with native permissions, localized tool summaries and recoverable model-visible errors; preserve existing drawing file compatibility.
## 3. User experience and validation
- [x] Refresh per-agent live drawing context before each model step, including text/style-only changes and selection; verify scoped isolation, closed editor instances and literal document content.
- [x] Connect selected-element requests and a visible AI-edit revert action without moving the viewport during ordinary edits.
- [x] Run unit tests and real Electron DSH → MCP → mounted canvas tests, including concurrent manual edits, duplicate requests, permission denial and persisted reopen; run typecheck, build and strict spec validation.
