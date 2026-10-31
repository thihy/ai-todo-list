## ADDED Requirements
### Requirement: Notify AI-created tasks
The app SHALL show a desktop notification with the persisted task title for each successfully created AI task, including background automations. Notifications SHALL distinguish automated creation and SHALL NOT focus the app until clicked. Duplicate result events, unsuccessful calls, task updates and history replay SHALL NOT create notifications.
#### Scenario: Automated creation
- **WHEN** an automation successfully creates a real task through todo_create
- **THEN** a desktop notification titled 自动化新增任务 displays the persisted task title
- **AND** clicking it restores and focuses the main window and opens that task
#### Scenario: OS unavailable
- **WHEN** desktop notifications are unsupported or fail
- **THEN** AI execution continues and the created task remains available
