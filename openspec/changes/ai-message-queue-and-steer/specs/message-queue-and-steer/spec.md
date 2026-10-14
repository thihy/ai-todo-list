## ADDED Requirements

### Requirement: Ordered queued messages
The application SHALL accept text and attachments during generation, capture their conversation association and deliver follow-ups in order after the active reply.

#### Scenario: Follow-up with an attachment
- GIVEN a reply is active
- WHEN the user queues text with an image
- THEN the message and attachment are delivered together after the reply.

#### Scenario: Stop or failure
- WHEN the active reply is stopped or fails
- THEN remaining messages are preserved and paused until the user resumes.

#### Scenario: Collapsed panel
- GIVEN messages are queued
- WHEN the user collapses the panel
- THEN queue processing continues without losing pending messages.

### Requirement: Active-task steering
The application SHALL deliver steering to the current task's next step, preserve its history and reject stale invocation delivery.

#### Scenario: Steering during generation
- WHEN the user submits steering while a task is running
- THEN it is consumed by that task at the next step boundary.

#### Scenario: Completed invocation
- WHEN the target finishes before steering is accepted
- THEN the message is queued as a follow-up.

### Requirement: Configurable shortcuts
The application SHALL default Enter to queue and Ctrl+Enter to steer and SHALL allow swapping them in settings.

#### Scenario: Swapped shortcuts
- GIVEN Enter is configured to steer
- WHEN the user presses Ctrl+Enter while generating
- THEN the message is queued.

#### Scenario: Composition or newline
- WHEN IME composition is active or Shift+Enter is pressed
- THEN no message is submitted.
