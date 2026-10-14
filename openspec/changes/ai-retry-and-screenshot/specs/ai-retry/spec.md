## ADDED Requirements
### Requirement: Retry the latest failed turn
The AI panel SHALL offer a retry action for the latest failed turn using its original text, attachments and intent and the currently configured model. It SHALL preserve the draft and SHALL prevent concurrent retry requests.

#### Scenario: Image retry
- **WHEN** a user retries a failed image message
- **THEN** its original image path is included and the user message remains a single visible message

#### Scenario: Another failure
- **WHEN** a retry fails again
- **THEN** the error and retry action remain available

#### Scenario: Retry with a draft
- **WHEN** the user has typed an unsent draft and retries a failure
- **THEN** the draft is retained

#### Scenario: Reload after retry
- **WHEN** the user reloads the conversation after retrying
- **THEN** the original user message is displayed once while attempt traces remain in history
