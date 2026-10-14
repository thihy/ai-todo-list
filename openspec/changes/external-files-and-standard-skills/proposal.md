# Proposal

## Why
External reads are denied even in full access and an empty agentsHome prevents discovery of the user's existing standard skills.

## What Changes
- Honor full access; add per-call external read confirmation and read-only directory allowlists.
- Discover ~/.agents/skills explicitly and support additional skill roots.
- Expose settings and defend canonical path boundaries.

## Capabilities
### New Capabilities
- `external-files-and-skills`: Permission-aware external reads and standard skill discovery.
### Modified Capabilities
None.

## Impact
DSH pre-execution guard, filesystem provider configuration, settings persistence/IPC/UI, path containment, documentation and tests.
