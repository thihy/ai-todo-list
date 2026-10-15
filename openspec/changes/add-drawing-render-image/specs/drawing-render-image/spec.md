## ADDED Requirements

### Requirement: Model can inspect rendered drawings
The application SHALL provide drawing_render which returns an actual durable image content block to an image-capable calling model.

#### Scenario: Model requests current drawing appearance
- **WHEN** a vision-capable model calls drawing_render with a real drawing ID
- **THEN** it SHALL receive the rendered PNG image and image dimensions in its tool result

#### Scenario: Text-only model requests an image
- **WHEN** the calling route does not declare image input
- **THEN** the tool SHALL return an actionable error without committing image content

### Requirement: Full scene PNG export
Exports SHALL include the current complete scene and embedded files, with a maximum side of 2048 pixels, independent of viewport or selection.

#### Scenario: Content extends outside the viewport
- **WHEN** an export is requested
- **THEN** all nondeleted scene elements SHALL be included without modifying the scene or user viewport

#### Scenario: Export fails or has no content
- **WHEN** the canvas is empty, unavailable or fails to respond
- **THEN** the operation SHALL return a bounded explicit error

### Requirement: User can download a PNG
The drawing editor SHALL offer a PNG export action.

#### Scenario: User exports a drawing
- **WHEN** the user activates the PNG export action
- **THEN** the full-scene image SHALL be offered as a PNG download
