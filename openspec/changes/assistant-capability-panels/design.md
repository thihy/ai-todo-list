# Design
## Context
The current automation UI is a long form in Settings. AIPane deliberately strips leading slashes, preventing native DSH commands. DSH supplies SkillRegistry, filesystem provider and CommandRuntime APIs in the installed version.
## Goals / Non-Goals
Reuse native registries and scheduler. Keep the existing visual palette. Remote registry marketplaces and arbitrary command execution are outside this change.
## Decisions
- The automation header icon opens a fixed-position, non-modal floating list anchored below the trigger. Skills retain their dedicated dialog. Clamp the automation panel to the viewport, preserve outside interaction, and dismiss on outside pointer, repeated trigger click or Escape. Escape restores trigger focus without cancelling a running AI turn.
- Automation rows show instruction summaries, schedules, state switches and edit/delete actions. Editing replaces the list within the same popover; the complete execution instruction is required and prominent. Header and footer remain fixed while content scrolls. Remove the duplicate Settings automation category.
- Move the existing permission control into the composer toolbar next to attachments, with a compact shield/text appearance and upward menu. Preserve all permission selection and full-access confirmation semantics.
- Composer attachment and screenshot actions use plain aligned glyphs without circular backgrounds; permissions use a lightweight inline label with an orange full-access state, and send/stop use a compact dark circle. Keep all existing attachment, screenshot and submission callbacks.
- Reuse DSH commands for discovery and execution, mounting /compact and host navigation commands in its registry. The composer offers keyboard selection; model requests keep their ordinary execution path.
- Read global Skill summaries from ctx.skills; append Codex and Claude global roots to existing provider configuration and read allowlist. Install local bundles into ~/.agents/skills and let native watchers refresh.
- Register automation tools against the shared scheduler, with explicit recurring intent documented in tool descriptions.
## Risks / Trade-offs
Native registry availability depends on AI boot; show retryable unavailable state. Skill files are user-provided instructions; installing them does not execute scripts or elevate tool access.
