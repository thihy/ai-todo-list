# Design

## Context
Main already owns AI execution, conversations and file-access policies. Standard Skill discovery and external access have focused regression tests.

## Goals / Non-Goals
Provide persistent schedules and inspectable results. OS-level wakeup and execution while the app is closed are outside this change.

## Decisions
- Use cron-parser for timezone-aware calendar calculations and five-field Cron validation instead of a custom calendar parser.
- Persist automation definitions and bounded run history atomically in a separate JSON file under the data directory, avoiding changes to task metadata. Write before dispatch to prevent restart replay.
- Export the existing ai.ask implementation as a reusable function. Both IPC and scheduler use its validation, costing, events and permissions.
- Each run gets a real conversation. Store its reference and result in history. Do not reuse an interactive conversation or grant elevated permissions.
- Skip downtime and overlapping occurrences. Restart marks in-flight history interrupted. Poll every 15 seconds only while the app is running and AI ready.

## Risks / Trade-offs
- Interactive approvals can wait for user attention; existing approval UI and deadlines remain authoritative.
- Local JSON supports the current single app process; multi-process writers are not supported.
- Calendar schedules inherit cron-parser DST semantics; timezone is stored explicitly.

## Migration Plan
No existing data migration. Disable the startup registration to roll back; stored schedules remain inert.
