## ADDED Requirements
### Requirement: Human edits reach the next model step
For an interactive turn, DSH SHALL refresh the bound mounted editor's actual scene and selection before each model request, without requiring a drawing tool call or creating an extra AI turn. Summaries SHALL include text, styles, geometry, additions, removals and selection changes, with explicit truncation for bounded context. Drawing content SHALL remain untrusted data.
#### Scenario: Human edits after a tool read
- **WHEN** the user changes the canvas while the model is reasoning
- **THEN** the next model step receives the updated scene and change summary even if no new drawing-read tool was called
- **AND** revision checks still reject an operation planned against the older scene
#### Scenario: Canvas and conversation isolation
- **WHEN** the user closes or remounts the bound editor, switches windows, or a background automation runs
- **THEN** the interactive turn does not silently bind another editor and the automation does not inherit the foreground canvas
- **AND** unavailable context does not masquerade as a current snapshot
### Requirement: MCP controls the embedded live drawing
The drawing engine SHALL expose a local MCP interface consumed by DSH, operating on the same embedded canvas the user edits and the existing task drawing file.
#### Scenario: Unsaved selection
- **WHEN** the user selects elements after a manual edit not yet autosaved
- **THEN** the context tool returns the live elements, actual selected IDs and current scene revision
- **AND** it does not substitute an independently stored or remote canvas
### Requirement: Incremental conflict-aware edits
The engine SHALL validate and atomically apply explicit element operations against the observed revision, preserve unrelated elements and bindings, and return affected IDs and the resulting revision. Idempotent operation IDs SHALL prevent duplicate application.
#### Scenario: Connect existing elements
- **WHEN** DSH adds a node and connects it to a real existing node
- **THEN** both endpoints and label bindings remain valid without regenerating the whole drawing
#### Scenario: User edits during model reasoning
- **WHEN** the scene revision changes before an AI batch is applied
- **THEN** the batch is rejected as a conflict without partial edits and the model can reread the scene
#### Scenario: Lost acknowledgement
- **WHEN** a request is repeated after an acknowledgement timeout
- **THEN** its operation ID returns the original outcome without adding duplicate elements
### Requirement: Reversible acknowledged AI edits
An applied AI batch SHALL have a bounded restoration checkpoint. Durable success SHALL be acknowledged only after saving the actual engine state through existing drawing persistence. Restoration SHALL preserve later user edits by rejecting conflicts.
#### Scenario: Restore the last batch
- **WHEN** the user reverts the latest AI batch without intervening edits
- **THEN** the engine and the persisted file return to the checkpoint
#### Scenario: Save failure
- **WHEN** persistence fails after a live mutation
- **THEN** the result explicitly identifies the failure and whether live state changed, and does not claim durable success
### Requirement: DSH integration preserves control boundaries
DSH SHALL discover and call the drawing tools through MCP with the existing permission semantics. Read-only access SHALL NOT allow mutation, and recoverable tool errors SHALL remain model-visible without automatically ending the turn.
#### Scenario: Read-only drawing assistance
- **WHEN** the active permission policy forbids changing the drawing
- **THEN** context and inspection remain available but mutations require approval or are denied by that policy
