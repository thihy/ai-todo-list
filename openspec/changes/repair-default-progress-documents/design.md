## Context
The running user's database reports versions through 22 but document_versions still has document_id and task_documents still exists. document.list returns no such column: todo_id. Fresh databases do not reproduce this.

## Decisions
Add v23 with structural detection. Already migrated tables are unchanged. Legacy tables reuse the v21 conversion transaction; links are copied before dropping task_documents, and history is joined to its real task and filename. Unsupported structures fail rather than guessing. Back up the running database and validate a copy before restarting the application.

Missing progress files are rebuilt from their latest document version. UI shows returned list/create errors. Stable task directory resolution remains unchanged.

## Validation
Test a synthetic v22 legacy schema including progress history, notes and links; reopen twice. Validate the actual backup copy has identical history/link counts. Then verify list and creation through the real Electron bridge after restart.
