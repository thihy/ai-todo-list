# AI Automations

## Purpose
Allow users to execute recurring AI instructions using persistent schedules, existing assistant permissions and inspectable execution history.

## ADDED Requirements

### Requirement: Persistent schedules
The system SHALL support daily, weekly and monthly calendar triggers, anchored intervals of at least one minute, and five-field Cron expressions with an explicit IANA timezone. Users SHALL create, edit, pause, resume, delete and manually run automations.

#### Scenario: Invalid schedule
- **WHEN** a user submits an invalid timezone, interval or Cron expression
- **THEN** the system rejects the change without altering the saved automation

### Requirement: Safe execution lifecycle
The system SHALL execute through the existing assistant request path using a real conversation, preserve normal permissions, prevent concurrent runs of the same automation, and show execution status, errors and conversation references. Running on startup SHALL skip missed occurrences and mark interrupted runs without replaying them. Scheduled execution SHALL require the app and AI runtime to be running.

#### Scenario: Restart after downtime
- **WHEN** the app restarts after several scheduled occurrences were missed
- **THEN** it schedules the next future occurrence and does not replay the missed instructions

#### Scenario: Overlap
- **WHEN** an automation is already running and is triggered again
- **THEN** no overlapping AI turn is started

#### Scenario: Permissions
- **WHEN** an automated instruction accesses an external file or invokes a Skill
- **THEN** the existing file access, Skill discovery and approval policies remain effective
