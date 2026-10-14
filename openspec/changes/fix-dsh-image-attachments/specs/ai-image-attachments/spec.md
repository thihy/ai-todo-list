## ADDED Requirements
### Requirement: Image-only submission
The application SHALL submit image attachments without requiring accompanying text and SHALL await pending clipboard imports before submitting.

#### Scenario: Immediate image submission
- **WHEN** the user pastes an image and immediately submits an empty text draft
- **THEN** the image is imported and its path is sent to DSH read_image

### Requirement: Durable raster previews
The application SHALL show raster attachment previews in the composer and sent turns using only registered inbox files.

#### Scenario: Reopen a conversation
- **WHEN** the user reopens a conversation containing an existing raster attachment
- **THEN** its thumbnail is rendered from the registered file

#### Scenario: Invalid preview request
- **WHEN** a preview requests an unregistered file or a path outside the inbox
- **THEN** the host refuses the request

### Requirement: Readable sent images
Sent images SHALL use a separate rounded preview with a secondary filename below it, aligned with the user's text, and SHALL preserve aspect ratio within the conversation width.

#### Scenario: Send a screenshot
- **WHEN** a user sends an image with text
- **THEN** the image preview is visible above the text without squeezing it into a filename capsule

### Requirement: Current model on subsequent turns
Existing conversations SHALL use the currently configured provider and model on their next admitted turn, including after restarting the application, while preserving their history.

#### Scenario: Remove a temporary model
- **WHEN** a temporary model is removed and the user continues its conversation with another configured model
- **THEN** the request uses the current model and does not attempt the removed model
