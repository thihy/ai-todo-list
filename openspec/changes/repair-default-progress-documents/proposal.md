## Why
Existing databases can report schema v22 while retaining document_id-based document history. New document loading queries todo_id and fails, hiding the default progress tab and newly created documents.

## What Changes
- Repair legacy document structure in migration v23 using column inspection.
- Preserve text history and links, restore missing progress files from saved content.
- Surface document list and creation errors, and ensure progress exists during refresh.

## Capabilities
### New Capabilities
- `document-schema-repair`: Restore document functionality for databases with mismatched version metadata.

## Impact
Database startup migrations, document handlers, document workspace and regression tests.
