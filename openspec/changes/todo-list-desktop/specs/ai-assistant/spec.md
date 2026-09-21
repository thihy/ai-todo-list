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

### Requirement: Workspace directory for AI filesystem access
The system SHALL create `<dataDir>/dsh_workspace/` on first boot and confine all DSH filesystem and shell tools to that root. `src/main/index.ts` MUST create the directory during data-dir setup and `process.env.DSH_WORKSPACE_ROOT` MUST be set before the DSH container is imported. `src/main/dsh/path-guard.ts` MUST validate every read path argument against the workspace and reject paths that escape it via absolute paths, `..`, symlinks, or junctions.

#### Scenario: Path outside workspace is rejected
- **WHEN** the AI calls `read({ file_path: '/etc/passwd' })`
- **THEN** the `tools/pre-execute` listener in `dsh-runtime.ts` returns `{ kind: 'deny', reason: 'PATH_OUTSIDE_WORKSPACE' }`
- **AND** the agent receives a structured error and no file content reaches the model

### Requirement: Filesystem and shell tools registered with DSH
The system SHALL expose `read`, `read_image`, `write`, `edit`, `bash` (POSIX), `pwsh` (Windows), `grep`, and `glob` as DSH tools via `@deepseek-ai/dsh-tool-fs`, `@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-pwsh`, and `@deepseek-ai/dsh-tool-fs-search`, loaded in `resources/dsh/cordis.yml`. Each tool SHALL be paired with its sandbox backend (`dsh-fs-sandbox`, `dsh-bash-sandbox`, `dsh-pwsh-sandbox`, `dsh-sandbox-policy`) for kernel-level confinement. The composition MUST mount `@deepseek-ai/dsh-sandbox-local` as the cross-platform cordis sandbox plugin (Windows ACL runner on win32; bwrap / Landlock / Seatbelt on POSIX); `@deepseek-ai/dsh-sandbox-windows-acl` is a runner backend library, not a cordis plugin, and MUST NOT be mounted directly. The shell-tool backends (`@deepseek-ai/dsh-subprocess-local`, `@deepseek-ai/dsh-spill-local`) are the cordis plugins; the abstract Service bases `@deepseek-ai/dsh-subprocess` and `@deepseek-ai/dsh-spill` are imported as types and MUST NOT be mounted (loading both abstract + local registers duplicate services).

#### Scenario: AI reads a workspace file
- **WHEN** the user asks the AI to read `dsh_workspace/notes.md`
- **THEN** the AI invokes `read({ file_path: 'notes.md' })` and the file is returned without user approval (read is auto tier)

### Requirement: Mandatory approval for mutating tools
The system SHALL force every call to `write`, `edit`, `bash`, and `pwsh` through `ctx.approval.request(...)` via a `tools/pre-execute` listener mounted in `src/main/dsh/dsh-runtime.ts`. The listener MUST return `{ kind: 'ask' }` regardless of DSH sandbox escalation arguments, and the existing `approval/request` waterfall listener MUST broadcast the request to the renderer for user response within 90 seconds before timing out.

The one exception is a session whose permission preset resolves to `auto`. There the listener MUST delegate to the `@nanmicoder/dsh-auto-mode` policy mounted in `resources/dsh/cordis.yml` and return `next()` instead of `{ kind: 'ask' }`, so the plugin's verdict governs. That plugin returns `allow` for deterministic-safe calls, `deny` for hard-denied ones (writes outside the workspace, credential reads, destructive targets, malformed sandbox escalations), and `ask` otherwise, which re-enters the same `approval/request` bridge and 90-second timeout. A classifier failure MUST fail closed. Every other preset (`read-only`, `workspace-write`, `danger-full-access`) MUST retain the unconditional `{ kind: 'ask' }` behavior above.

#### Scenario: Write requires approval
- **WHEN** the AI calls `write({ file_path: 'a.txt', content: 'hi' })` in a session whose preset is not `auto`
- **THEN** `PendingApprovalCard` displays the file path, byte length, and a 200-character content preview
- **AND** the tool only proceeds if the user approves within 90 seconds

#### Scenario: Auto preset delegates shell approval
- **WHEN** the AI calls `pwsh({ command: 'Get-ChildItem' })` in a session whose preset is `auto`
- **THEN** the auto-mode policy classifies the call and, when it is deterministic-safe, the tool runs without displaying `PendingApprovalCard`
- **AND** a destructive or outside-workspace command is denied without prompting
- **AND** an ambiguous command still displays `PendingApprovalCard` with the plugin's stated reason

### Requirement: Persistent and session tool grants
The system SHALL persist user-approved tool grants in `PersistedSettings.aiGrantedTools` as `Record<toolName, 'session' | 'always'>`. `session` grants SHALL expire on app restart and apply only to the current conversation. `always` grants SHALL persist across restarts and apply globally. The Settings UI MUST list currently-granted tools with a revoke button. The `approval/request` waterfall listener in `src/main/dsh/dsh-runtime.ts` MUST short-circuit when the requested tool is in either grants table.

#### Scenario: User grants always for read
- **WHEN** the user clicks "始终允许此工具" on a `read` approval card
- **THEN** `ai.userApproval.grantAlways({ toolName: 'read' })` writes `aiGrantedTools.read = 'always'` to `config.json`
- **AND** subsequent `read` calls in any conversation resolve without prompting

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