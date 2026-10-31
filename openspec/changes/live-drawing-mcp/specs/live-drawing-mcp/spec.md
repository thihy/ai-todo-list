## ADDED Requirements
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
