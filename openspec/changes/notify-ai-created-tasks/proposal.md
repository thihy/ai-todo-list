# Why
AI-created tasks, especially background automation results, need a desktop notification so users notice new work without watching the conversation.

# What Changes
Notify after a successful live todo_create result backed by a real task row. Distinguish automated creation, show the task title, and open details on click. Handle native DSH results and suppress duplicates, failures, updates and history replay.

# Capabilities
## New Capabilities
- `ai-task-notifications`: desktop notifications for AI-created tasks.
## Modified Capabilities
None.

# Impact
Shared AI execution entry, native desktop notifications, regression tests. No storage or task-creation consent changes.
