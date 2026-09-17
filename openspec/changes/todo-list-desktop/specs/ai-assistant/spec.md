## Purpose

让 AI 真正参与到 TODO 生命周期:从自然语言采集、智能整理、自动生成进展草稿、数据分析,到基于上下文的总结与下一步建议,形成"采集 → 整理 → 描述 → 可视化 → 复盘"的闭环。AI 运行时以 DeepSeek Harness (DSH) 作为进程内库加载,我们的 TODO 能力作为 DSH tools/skills 暴露给 agent。

## ADDED Requirements

### Requirement: DeepSeek as the default AI provider
The system SHALL default to DeepSeek (via `@deepseek-ai/dsh-llm-deepseek`) and SHALL also expose `openai`, `anthropic`, `ollama`, and a user-defined OpenAI-compatible `custom` endpoint via `@deepseek-ai/dsh-llm-pi-ai` + `@earendil-works/pi-ai`. The default base URL is `https://api.deepseek.com/v1`; other providers are configured in Settings. The system SHALL allow the user to choose the model per provider (e.g. `deepseek-chat` / `deepseek-reasoner`) in settings.

#### Scenario: User picks provider + model
- **WHEN** the user selects `anthropic` and a model id in AI settings
- **THEN** subsequent agent invocations use that provider + model
- **AND** the choice is persisted across restarts
- **AND** no application restart is required for the change to take effect

### Requirement: API key isolation
The system SHALL store provider API keys in the main process only and MUST NOT expose them to the renderer process. All AI requests MUST be proxied through the main process via IPC.

#### Scenario: Renderer cannot read the key
- **WHEN** the renderer queries `window.todoList.settings.get({ key: 'apiKey' })`
- **THEN** the main process returns a redacted response
- **AND** the API key never enters the renderer's JavaScript context

#### Scenario: AI requests proxied through main
- **WHEN** the renderer requests an AI operation
- **THEN** the call is dispatched on the main process where the key lives
- **AND** the response (or stream events) is delivered back through the typed IPC schema

### Requirement: DSH runtime embedded in-process
The system SHALL embed DeepSeek Harness as an in-process Node library, composing its bundles through a single Cordis container owned by the Electron main process. The system MUST NOT spawn a `dsh` subprocess. The eager `container.ts` handle exposes only `{ health, models }`; the real agent loop lives in `dsh-runtime.ts` and boots lazily on the first `ai.ask`.

#### Scenario: DSH modules imported directly
- **WHEN** the main process boots
- **THEN** it imports `@deepseek-ai/cordis`, `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-persistence-jsonl`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-deepseek`, `@deepseek-ai/dsh-llm-pi-ai` directly via `npm` resolution
- **AND** constructs a single Cordis container that hosts both DSH bundles and our domain tools (registered in `registerDomainTools` inside `dsh-runtime.ts`)

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
The system SHALL classify every DSH tool into one of three host-owned tiers defined in `src/shared/permission-tiers.ts`: `auto` (runs without prompting), `notify-undo` (8-second undo toast), or `block` (explicit user approval per call). Destructive tools (`todo.delete`, `content.writeBody` for non-empty bodies, `content.restoreVersion`, `drawing.delete`) MUST be classified as either `notify-undo` or `block`. The `registerDomainTools` entry in `src/main/dsh/dsh-runtime.ts` MUST consult `tierFor(toolName)` before executing any tool call.

#### Scenario: Delete requires confirmation
- **WHEN** a DSH skill attempts to call `todo_delete`
- **THEN** the main process intercepts the call and surfaces a "Allow this AI action?" prompt to the user
- **AND** the call only proceeds if the user approves within 30 seconds, otherwise it times out and the skill receives a denial event

#### Scenario: Notify-undo surfaces an undo toast
- **WHEN** a tool classified as `notify-undo` (e.g. `todo_update` on an existing task) executes
- **THEN** the renderer shows an 8-second "已撤销" toast wired to `window.todoList.ai.undo` IPC
- **AND** pressing the toast within 8 seconds reverts the change and logs `ai.undo` in the session

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
The system SHALL pin `@deepseek-ai/cordis*` and `@deepseek-ai/dsh-*` packages to `0.1.5-rc.2` and `@earendil-works/pi-ai` to `0.85.1` in `package.json`, and SHALL NOT automatically upgrade across minor lines without a documented OpenSpec migration change.

#### Scenario: Upgrade is intentional
- **WHEN** a contributor changes any `@deepseek-ai/dsh-*` or `@deepseek-ai/cordis*` dependency range
- **THEN** the change requires a CHANGELOG entry, a dedicated OpenSpec change describing the migration, and a re-run of `openspec validate`
- **AND** silent `*` or `latest` ranges are forbidden by an ESLint rule on `package.json`