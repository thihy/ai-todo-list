## Purpose

允许用户为每条 TODO 绑定 Excalidraw 画布,用于画架构图、流程图或随手涂鸦,让白板成为 TODO 进展的一部分并能被搜索与浏览。

## ADDED Requirements

### Requirement: Attach drawings to a TODO
The system SHALL allow zero or more Excalidraw drawings to be attached to each TODO, with each drawing stored as a `.excalidraw` JSON file under `~/.todo-list/drawings/<todo-id>/<drawing-id>.excalidraw`.

#### Scenario: New drawing from TODO detail
- **WHEN** the user clicks "Add drawing" on a TODO
- **THEN** a new Excalidraw scene opens in a side panel
- **AND** on save, a `.excalidraw` file is written and indexed against the TODO

#### Scenario: Drawings listed under TODO
- **WHEN** the user opens the TODO detail
- **THEN** all attached drawings are listed with title and last-modified time

### Requirement: Thumbnail and inline preview
The system SHALL render a PNG thumbnail for each attached drawing and show it in the TODO list and detail views.

#### Scenario: Thumbnail regenerated on save
- **WHEN** a drawing is saved
- **THEN** a thumbnail PNG is produced and stored next to the `.excalidraw` file
- **AND** the rendered thumbnail is shown in the UI within 1 second

### Requirement: Bidirectional links
The system SHALL support wiki-style `[[todo:abc123]]` links inside both Markdown bodies and Excalidraw text labels, navigable by click.

#### Scenario: Navigate from drawing to TODO
- **WHEN** the user clicks an element in a drawing that contains a `[[todo:abc123]]` link
- **THEN** the TODO with id `abc123` opens in the detail panel

#### Scenario: Navigate from Markdown to TODO
- **WHEN** the user clicks a `[[todo:abc123]]` link in a Markdown body
- **THEN** the linked TODO opens in the detail panel

### Requirement: Backlinks panel
The system SHALL display, on each TODO detail page, all other TODOs and drawings that link to the current TODO.

#### Scenario: Show backlinks
- **WHEN** the user opens TODO A
- **THEN** a backlinks section lists every TODO whose body or drawing references `[[todo:A]]`