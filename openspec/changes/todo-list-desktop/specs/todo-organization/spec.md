## Purpose

为已采集的 TODO 提供多维分类（标签 / 项目 / 优先级 / 状态）、多视图（列表 / 看板 / 日历）和高效筛选与排序，让用户能持续维护一个清晰、可执行的任务集合。

## ADDED Requirements

### Requirement: Tag and project assignment
The system SHALL allow every TODO to carry zero or more tags and to belong to zero or one project, and these attributes MUST be filterable.

#### Scenario: Assign tag and project
- **WHEN** the user adds the tag `#design` and project `@work` to a TODO
- **THEN** both attributes are persisted and appear on the TODO card

#### Scenario: Filter by tag and project
- **WHEN** the user filters the list by tag `design` and project `work`
- **THEN** only TODOs matching both attributes are shown
- **AND** the active filter is reflected in the URL/state and survives a restart

### Requirement: Priority and status
The system SHALL support four priority levels (none, low, medium, high) and at least five statuses (`inbox`, `next`, `doing`, `blocked`, `done`).

#### Scenario: Status transition
- **WHEN** the user moves a TODO from `next` to `doing`
- **THEN** the TODO appears in the `doing` column of the kanban view
- **AND** a timestamp for the transition is recorded

#### Scenario: Priority sort
- **WHEN** the user sorts by priority descending
- **THEN** TODOs are ordered high → medium → low → none, with stable secondary sort by due date

### Requirement: Multiple views
The system SHALL provide list, kanban (grouped by status), and calendar (grouped by due date) views of the TODO collection.

#### Scenario: Switch view
- **WHEN** the user switches to kanban view
- **THEN** TODO cards appear under columns keyed by status
- **AND** drag-and-drop between columns updates the TODO status

#### Scenario: Calendar view groups by due date
- **WHEN** the user switches to calendar view
- **THEN** TODOs appear on their due date; TODOs without a due date appear in an "unscheduled" lane

### Requirement: Batch operations
The system SHALL allow selecting multiple TODOs and applying tag, project, priority, status, or delete operations in a single action.

#### Scenario: Batch tag
- **WHEN** the user selects 5 TODOs and adds the tag `review`
- **THEN** all 5 TODOs carry the tag `review` after the action