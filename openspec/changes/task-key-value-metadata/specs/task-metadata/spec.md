## ADDED Requirements
### Requirement: Custom task metadata
The system SHALL persist task metadata as a string KV object. Existing tasks SHALL default to an empty object. Omitting metadata SHALL preserve it; submitting an empty object SHALL clear it. The system SHALL validate limits and reject invalid keys and values.
#### Scenario: Custom external ID
- **WHEN** a user saves an external ID with leading zeros
- **THEN** the exact string survives task rename, reload and application restart
#### Scenario: Invalid draft
- **WHEN** the editor contains duplicate or empty keys
- **THEN** saving shows a validation error without changing persisted metadata
#### Scenario: AI access
- **WHEN** an authorized AI tool updates custom metadata
- **THEN** the task API and editor read the same persisted values
