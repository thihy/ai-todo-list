# Assistant Capabilities
## Purpose
Give users direct assistant-side control over scheduled instructions, native skills and discoverable system commands without navigating a long settings form.
## ADDED Requirements
### Requirement: Assistant management entry points
The assistant SHALL expose accessible automation and Skill buttons in its header. The automation button SHALL open a non-modal floating list below its trigger, showing description summaries, schedules, enable/disable switches and edit/delete actions. It SHALL close on outside click, repeated trigger click or Escape, stay within the viewport, and show an optional contextual editor with a required full execution instruction. Settings SHALL omit the duplicate automation category. A shortcut SHALL allow composing a creation request in chat.
#### Scenario: Empty automation list
- **WHEN** the user opens automation management
- **THEN** the user sees a concise empty state, a conversational creation action and an optional manual editor
#### Scenario: Contextual edit
- **WHEN** the user edits an automation
- **THEN** the same popover shows its existing name, complete required execution instruction and schedule, with save/cancel actions returning to the list
- **AND** disabled definitions show no next execution time
### Requirement: Composer permission control
The existing permission selector SHALL appear beside the composer's attachment control, with an upward menu and visible full-access state, while preserving selection and draft-session behavior without an additional confirmation dialog.
#### Scenario: Permission selection
- **WHEN** a user opens the permission selector in an existing or draft conversation
- **THEN** its choices remain available inside the composer toolbar and full-access selection takes effect directly without a confirmation dialog
### Requirement: Conversational automation management
The assistant SHALL use tools backed by the same scheduler as the UI to list, save and remove definitions. The assistant MUST query real IDs before editing and MUST NOT invent schedules or enable recurring work without an explicit user request.
#### Scenario: Explicit recurring request
- **WHEN** a user asks to summarize tasks every weekday at 09:00
- **THEN** the assistant can save the recurring instruction and report the actual next occurrence
#### Scenario: Catalog changes while management is open
- **WHEN** a DSH automation tool creates, edits, enables, disables or removes a definition
- **THEN** the open management list SHALL refresh from the same authoritative catalog immediately after successful persistence, without waiting for polling
- **AND** an older in-flight read SHALL NOT overwrite a newer result
### Requirement: Native Skill catalog and installation
The system SHALL display the native DSH Skill registry, including standard global and configured roots. Local bundle installation SHALL validate via the native provider, reject symlink content and existing destinations, and leave loading to DSH.
#### Scenario: Existing destination
- **WHEN** a user installs an already installed Skill
- **THEN** the system rejects the installation without overwriting the existing bundle
### Requirement: Slash command discovery and dispatch
The composer SHALL preserve slash-prefixed input and show a filterable keyboard-accessible command menu. Native commands SHALL execute through DSH commands without being converted into model prompts. Unknown slash commands SHALL return a visible error without silently removing the prefix.
#### Scenario: Native compaction
- **WHEN** the user submits /compact
- **THEN** the native DSH command executes and its result is shown
