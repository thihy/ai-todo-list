## 1. Native drawing operations
- [x] Remove drawing_read from model-facing registration and prompts; prohibit raw JSON/file fallback and verify advertised tools.
- [x] Support validated text container/alignment arguments through actual engine bindings and regression tests.
- [x] Inventory every installed native action and expose awaited native registry/action APIs with version-checked development/production build integration.
- [x] Connect all native actions to typed IPC/DSH with permissions, action guidance, conflict/idempotency, actual-state save/checkpoint and honest UI outcomes.
- [x] Attempt every registered action with suitable fixtures and record complete coverage; verify native edit/action families in real Electron.
## 2. Selection annotations
- [x] Add viewport-clamped selection annotation composer, editable/deletable pending drafts, target highlighting and per-drawing draft recovery.
- [x] Send one batch ordinary-chat message through the existing assistant admission/queue path, handle collapsed/busy/errors without losing drafts and verify actual element references.
## 3. Floating progress editor
- [x] Add dedicated usable progress window and remove the compact inline overlay; cover geometry, save/cancel, errors and minimum floating size.
## 4. Validation
- [x] Run typecheck, relevant/full tests, strict specs and production build; verify UI through CDP screenshots and real Electron, including persisted results and failure continuation.
