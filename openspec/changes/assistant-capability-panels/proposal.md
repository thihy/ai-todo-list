# Proposal
## Why
Automation management is buried in a long settings form. Users need compact assistant-side entry points, conversational scheduling and access to their global DSH skills.
## What Changes
- Add automation and Skill icons on the assistant header opening compact management dialogs.
- Show automation cards first, with an optional editor and a conversational creation shortcut.
- Register assistant automation tools using the same scheduler as the UI.
- Expose the native DSH Skill catalog, discover user global roots, and install local Skill bundles without overwriting existing ones.
## Capabilities
### New Capabilities
- `assistant-capability-panels`: Assistant-side automation and native Skill management.
### Modified Capabilities
None.
## Impact
Assistant UI, DSH tool registration, native filesystem provider configuration, typed IPC and regression tests. Existing automation scheduling semantics remain unchanged.
