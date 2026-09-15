## Purpose

让 AI 真正参与到 TODO 生命周期:从自然语言采集、智能整理、自动生成进展草稿、数据分析,到基于上下文的总结与下一步建议,形成"采集 → 整理 → 描述 → 可视化 → 复盘"的闭环。AI 运行时以 DeepSeek Harness (DSH) 作为进程内库加载,我们的 TODO 能力作为 DSH tools/skills 暴露给 agent。

## ADDED Requirements

### Requirement: DeepSeek as the only AI provider
The system SHALL use DeepSeek (via `@deepseek-ai/dsh-llm-deepseek`) as the sole LLM provider. The DeepSeek API base SHALL be `https://api.deepseek.com/v1` and SHALL NOT be user-configurable in v1. The system SHALL allow the user to choose between `deepseek-chat` and `deepseek-reasoner` in settings.

#### Scenario: User picks model
- **WHEN** the user selects `deepseek-reasoner` in AI settings
- **THEN** subsequent agent invocations use `deepseek-reasoner`
- **AND** the choice is persisted across restarts

### Requirement: API key isolation
The system SHALL store the DeepSeek API key in the main process only and MUST NOT expose it to the renderer process. All AI requests MUST be proxied through the main process via IPC.

#### Scenario: Renderer cannot read the key
- **WHEN** the renderer queries `window.todoList.settings.get({ key: 'deepseekApiKey' })`
- **THEN** the main process returns a redacted response
- **AND** the API key never enters the renderer's JavaScript context

#### Scenario: AI requests proxied through main
- **WHEN** the renderer requests an AI operation
- **THEN** the call is dispatched on the main process where the key lives
- **AND** the response (or stream events) is delivered back through the typed IPC schema

### Requirement: DSH runtime embedded in-process
The system SHALL embed DeepSeek Harness as an in-process Node library, composing its bundles through a single Cordis container owned by the Electron main process. The system MUST NOT spawn a `dsh` subprocess.

#### Scenario: DSH modules imported directly
- **WHEN** the main process boots
- **THEN** it imports `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-llm-deepseek` directly via `npm` resolution
- **AND** constructs a single Cordis container that hosts both DSH bundles and our plugins

#### Scenario: No extra process
- **WHEN** the user invokes an AI feature
- **THEN** the work happens in the existing Electron main process
- **AND** no additional Node process is observable in the OS process list

### Requirement: AI quick capture parsing
The system SHALL provide a "natural-language capture" skill implemented as a DSH skill, which parses free-form text into structured TODO fields.

#### Scenario: Parse natural-language capture
- **WHEN** the user types "周五前完成登录页 A/B 测试报告 !p1 @data" into capture
- **THEN** the DSH skill proposes a structured TODO with title, due date, priority `p1`, project `data`
- **AND** the user can accept or override before commit

### Requirement: Draft progress from context
The system SHALL provide a "draft progress" DSH skill that uses the TODO's title, body, tags, and any attached drawings to generate a Markdown progress section.

#### Scenario: Generate progress draft
- **WHEN** the user invokes "Draft progress" on a TODO
- **THEN** a Markdown block is inserted at the cursor or returned for review
- **AND** the draft is clearly marked as AI-generated until the user accepts it

### Requirement: Summarize and suggest next steps
The system SHALL provide a "summarize" DSH skill that produces a short summary and up to three suggested next actions for a TODO.

#### Scenario: Summarize long body
- **WHEN** the user clicks summarize on a TODO with a long Markdown body
- **THEN** a ≤120-character summary appears, followed by up to three suggested next TODOs

### Requirement: Data analysis skill
The system SHALL provide a "data analysis" DSH skill that consumes the user's TODO history (read via our DSH tools) and produces an analytical Markdown report, which the skill writes back through the `content.writeBody` tool against a designated report TODO.

#### Scenario: Generate weekly report
- **WHEN** the user invokes "Generate weekly report" in AIPanel
- **THEN** the data-analysis skill reads `todo.search({createdAfter: 7d})` and `todo.stats` via DSH tools
- **AND** writes the result into TODO "周报-<YYYY-Www>" via `content.writeBody`
- **AND** the report TODO opens in the detail view with the new content

### Requirement: TODO tools registered with DSH
The system SHALL register the application's TODO, content, drawing, and search capabilities as DSH tools, so any DSH skill (built-in or our own) can call them through the standard DSH tool pipeline.

#### Scenario: Skill invokes todo.search
- **WHEN** any DSH agent calls the `todo_search` tool with a query
- **THEN** the call is dispatched to our `TodoRepo.search` and the result is returned through the DSH tool pipeline
- **AND** the same call is auditable in the DSH session log

### Requirement: Permission boundaries on destructive tools
The system SHALL configure DSH permissions so that destructive tools (e.g. `todo.delete`, `content.overwriteBody` for non-empty bodies, `drawing.delete`) MUST require explicit user approval per call.

#### Scenario: Delete requires confirmation
- **WHEN** a DSH skill attempts to call `todo_delete`
- **THEN** the main process intercepts the call and surfaces an "Allow this AI action?" prompt to the user
- **AND** the call only proceeds if the user approves within 30 seconds, otherwise it times out and the skill receives a denial event

### Requirement: Streaming responses
The system SHALL stream AI responses to the UI for any request longer than 2 seconds, showing progressive output.

#### Scenario: Streamed summary
- **WHEN** the user requests a summary on a long body
- **THEN** text appears incrementally rather than after the full completion

### Requirement: Provider failure handling
The system MUST surface AI errors clearly to the user and MUST NOT silently swallow them or block the rest of the app.

#### Scenario: Network failure
- **WHEN** the DeepSeek provider returns an error or times out
- **THEN** the user sees a non-blocking toast with the error message
- **AND** the TODO editor and capture remain usable offline

### Requirement: DSH version stability
The system SHALL pin DSH packages to a specific `*-rc.*` version (e.g. `^0.0.1-rc.1`) and SHALL NOT automatically upgrade across minor lines without a documented migration.

#### Scenario: Upgrade is intentional
- **WHEN** a contributor changes any `@deepseek-ai/dsh-*` dependency range
- **THEN** the change requires a CHANGELOG entry and a re-run of `openspec validate`
- **AND** silent `*` or `latest` ranges are forbidden by an ESLint rule on `package.json`