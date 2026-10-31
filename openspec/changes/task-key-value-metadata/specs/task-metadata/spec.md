## ADDED Requirements
### Requirement: Compact additional-information chapter
The task details SHALL label custom metadata as 附加信息 and show a single-line key=value summary by default. Editing controls SHALL remain hidden until requested. Overflow SHALL expose 更多 to expand and 收起 to restore the single line, preserving the underlying KV values.
#### Scenario: Overflow
- **WHEN** the custom-field summary exceeds the available width
- **THEN** the summary remains one line and provides an expandable 更多 action

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
