## ADDED Requirements
### Requirement: Authoritative AI execution lifecycle
The UI SHALL reconcile AI execution against main-process state on restoration and while open. A completed tool dispatch or internal plan SHALL NOT imply the overall execution or background job is complete. Cancellation SHALL remain in progress until main confirms real termination. Stale cancellation requests SHALL NOT cancel replacement invocations.
#### Scenario: Reload while running
- **WHEN** the renderer reloads while a model invocation is running
- **THEN** it recovers and displays actual running state and clears it only after backend settlement
#### Scenario: Background shell dispatch
- **WHEN** a shell result contains a background job handle
- **THEN** the tool row labels it as submitted rather than completed and actual execution state includes owned live jobs
#### Scenario: Stop pending
- **WHEN** cancellation is requested but execution has not settled
- **THEN** the UI remains busy and displays a stopping state
### Requirement: Honest tool output diagnostics
Tool rows SHALL distinguish recorded empty output from missing results and user interruption. Missing results SHALL expose tool name and call ID. Ordinary tool errors SHALL remain available to the model without host cancellation. Internal todo_write SHALL be labeled 更新执行计划 and summarize its steps without creating user tasks.
#### Scenario: Missing PowerShell output
- **WHEN** a PowerShell call has no recorded result
- **THEN** the UI states that its execution outcome is unknown and provides diagnostics rather than claiming completion or replaying it
### Requirement: Floating subtasks
The floating view SHALL include active children and grandchildren independently of the completion state of their parents and SHALL identify them as subtasks.
#### Scenario: Completed parent
- **WHEN** a completed parent has an active child and grandchild
- **THEN** both descendants are eligible for floating rows and the completed parent is excluded
