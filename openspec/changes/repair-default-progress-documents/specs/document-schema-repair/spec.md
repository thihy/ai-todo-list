## ADDED Requirements

### Requirement: Repair legacy document structures
The application SHALL migrate document_id-based document history even when existing version metadata is 22, preserving resolvable history and links.

#### Scenario: Existing v22 database still has old document columns
- **WHEN** the application opens the database
- **THEN** history SHALL use todo_id and file_name, links SHALL remain accessible, and document listing and creation SHALL work

#### Scenario: Schema already uses file names
- **WHEN** the application runs the repair migration or restarts again
- **THEN** existing document history SHALL remain unchanged

### Requirement: Default progress remains available
Each task SHALL have its default progress document when listing or refreshing documents. Missing projections SHALL use saved progress content when available.

#### Scenario: Default progress file is missing
- **WHEN** defaults are ensured
- **THEN** progress.md SHALL be restored without losing its saved text history

### Requirement: Document failures are visible
The workspace SHALL display returned listing or creation errors.

#### Scenario: Listing fails
- **WHEN** the backend returns a document listing error
- **THEN** the user SHALL see the failure rather than only an empty workspace
