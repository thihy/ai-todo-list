## ADDED Requirements
### Requirement: Complete native actions are callable
The AI SHALL be able to discover and invoke every action actually registered by the installed Excalidraw engine, using real native action behavior and explicit input/prerequisite guidance. Unknown or disabled actions SHALL return actionable errors. UI/clipboard/file actions SHALL report their actual outcome and any remaining human interaction. Invocation SHALL preserve existing permissions, revision checks, deduplication and honest persistence reporting.
#### Scenario: Native grouping and alignment
- **WHEN** the AI selects real elements and requests group or alignment
- **THEN** the engine executes the native action against those elements and persists the actual result
#### Scenario: Complete inventory
- **WHEN** the engine version or registered action set changes
- **THEN** coverage checks identify missing or changed entries instead of silently excluding actions
### Requirement: Drawing assistance does not fall back to raw scene JSON
The model-facing drawing_read tool SHALL be removed. Drawing assistance SHALL use the live engine and SHALL NOT fall back to filesystem or full-scene JSON rewriting on tool failure. Bound text with supported alignment SHALL use validated native binding/layout.
#### Scenario: Validation error recovery
- **WHEN** an engine operation fails input validation
- **THEN** the AI receives the error and corrects the native/semantic request without using a raw scene fallback
### Requirement: Batch selected-element annotations
Selecting elements SHALL offer an anchored AI annotation composer. Users SHALL be able to save, edit and remove multiple annotations and submit them as one ordinary AI message with real drawing and element references. Unsubmitted drafts SHALL survive tab changes, and failed dispatch SHALL preserve them.
#### Scenario: Multiple selection targets
- **WHEN** the user annotates two different selections and submits the batch
- **THEN** the assistant receives one message containing both literal instructions with their respective real targets, without creating a todo or overwriting the drawing
### Requirement: Floating progress editor has independent space
Progress entry from a floating todo SHALL use an independent, fully opaque editor outside the task-list surface and sized for its content, regardless of the floating window's height. Closing or cancelling SHALL NOT save.
#### Scenario: Minimum size floating window
- **WHEN** the user chooses progress entry on a task in the smallest floating window
- **THEN** the complete progress form is usable in its own window and the task list retains its original layout
