## ADDED Requirements
### Requirement: Managed automation conversation groups
The system SHALL automatically associate every execution conversation with its automation ID. Groups SHALL follow the automation name and lifecycle and SHALL NOT expose independent rename or delete controls.

#### Scenario: Repeated executions
- **WHEN** the same automation executes twice
- **THEN** two separate conversations appear in the same collapsible group

#### Scenario: Identical names
- **WHEN** two automations have the same name
- **THEN** their groups remain separate by ID

#### Scenario: Task deletion
- **WHEN** an automation is removed
- **THEN** its group disappears and existing execution conversations remain accessible under ungrouped history

#### Scenario: Historic runs
- **WHEN** saved runs identify existing execution conversations
- **THEN** ownership is backfilled by exact ID without inferring ownership from titles
