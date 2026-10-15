## ADDED Requirements

### Requirement: Live canvas admission
The application SHALL admit AI drawing only after the target editor has a usable drawing API and SHALL acknowledge success only after persistence succeeds.

#### Scenario: First drawing on a cold canvas
- WHEN AI requests a new drawing
- THEN the canvas opens, waits for its API, applies the diagram and saves before success is reported.

### Requirement: Isolated editor input
The application SHALL keep unrelated text inputs usable across drawing operations and scene refreshes.

#### Scenario: Scene changes while the user types elsewhere
- WHEN an AI drawing refresh arrives
- THEN the live canvas is updated without replacing its editor or stealing text-input focus.

#### Scenario: Save shortcut outside the drawing
- WHEN a text input outside the drawing receives Ctrl+S
- THEN the drawing's shortcut listener does not intercept it.

#### Scenario: Restoring transient UI state
- GIVEN a stored scene contains an open dialog or active editing state
- WHEN the scene is loaded
- THEN that transient state is not restored as a focus trap.

### Requirement: Validate semantic node shapes before conversion
The drawing pipeline SHALL map cylinder storage nodes to compatible rectangles and reject other unsupported shapes before passing them to Excalidraw. Renderer validation SHALL reject invalid element IDs or unresolved arrow endpoints without mutating the existing scene.

#### Scenario: Architecture diagram contains storage cylinders
- **WHEN** a drawing request includes cylinder nodes connected by labelled arrows
- **THEN** their labels and bindings SHALL be preserved using supported rectangle containers

