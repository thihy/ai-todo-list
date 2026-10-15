# Tasks

## 1. Editor lifecycle
- [x] 1.1 Gate readiness on the real API and verify delayed initialization tests.
- [x] 1.2 Preserve the live editor across refreshes, cancel stale saves and scope shortcuts; verify focus/refresh tests.
- [x] 1.3 Sanitize transient UI state and use the installed updateScene contract; verify scene application and failure tests.

## 2. Integration
- [x] Reject XML-shaped full scenes before saving, show invalid-scene load errors, preserve the user's edits when repairing the confirmed corrupted scene, and use serialized JSON for drawing_save.
- [x] Validate node kinds before conversion, map cylinder to supported rectangles and replay the user's complete architecture fixture through the real converter.
- [x] 2.1 Verify cold AI drawing, persisted elements and subsequent keyboard input in an isolated Electron profile. The full application-wide input lock was not reproduced; see docs/ai-drawing-lifecycle.md.
- [x] 2.2 Complete typecheck, focused tests, build and documentation; remove the temporary launcher.
