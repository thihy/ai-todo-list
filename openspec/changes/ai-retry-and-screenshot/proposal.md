## Why
AI failures currently leave no way to resend the original message. Users also need to capture a window or screen region directly as an AI image attachment.

## What Changes
- Add retry to the latest failed AI turn, retaining its original text, attachments and intent.
- Add a screenshot control to the AI composer with window detection, manual region selection, confirmation and cancellation.

## Capabilities
### New Capabilities
- `ai-retry`: retry failed messages without duplicating their visible user message or discarding draft input.
- `screen-capture`: capture a selected desktop window or region into the existing AI attachment inbox.
### Modified Capabilities
None.

## Impact
AIPane, AIComposer, IPC/preload, Electron capture overlays and build entries. Explicitly declare the already-installed Koffi dependency for Windows window enumeration. No PixPin binary dependency.
