## Purpose

让每条 TODO 拥有独立的 Markdown 文件用于富内容描述与进展记录,支持编辑、实时预览、版本记录与全文搜索,从而让"思考过程"和"任务本身"同等可被检索与回溯。

## ADDED Requirements

### Requirement: Per-TODO markdown file
The system SHALL associate each TODO with a Markdown file at `~/.todo-list/todos/<todo-id>.md`, containing YAML front-matter with the canonical TODO fields and a Markdown body for notes/进展.

#### Scenario: Create TODO creates md file
- **WHEN** a new TODO is created
- **THEN** a corresponding `.md` file is written with front-matter matching the DB record and an empty body

#### Scenario: Edit body is persisted
- **WHEN** the user edits the Markdown body and saves
- **THEN** the change is written to the `.md` file
- **AND** the DB record's `updated_at` advances

### Requirement: Split editor with preview
The system SHALL provide a split editor showing Markdown source on the left and rendered preview on the right, with synchronized scrolling.

#### Scenario: Live preview
- **WHEN** the user types Markdown source
- **THEN** the preview pane updates within 300ms
- **AND** scrolling either pane mirrors the other

### Requirement: Version history
The system SHALL retain at least the last 20 versions of each TODO's Markdown body and allow restoring any prior version.

#### Scenario: Restore prior version
- **WHEN** the user opens history, selects an older version, and clicks restore
- **THEN** the current body is replaced by the selected version
- **AND** a new history entry is recorded so the revert is itself reversible

### Requirement: Full-text search
The system SHALL provide full-text search across all TODO Markdown bodies and titles, returning ranked results with highlighted snippets.

#### Scenario: Search ranks by relevance
- **WHEN** the user searches "登录页"
- **THEN** results include TODOs whose title or body contain the term
- **AND** titles matches rank above body-only matches