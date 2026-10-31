# Design

## Current evidence
- `drawing_read` reads the file store; live selection is not exposed.
- `applySkeletonBatch` appends elements and checks connector endpoints only within the incoming batch.
- `drawing_save` is whole-scene file replacement, unsuitable for concurrent live editing.
- `DrawingCanvasHost` already handles readiness, request IDs, exports and renderer acknowledgements.
- DSH's current config has no MCP client connection. Existing Excalidraw MCP Apps must not be assumed to control this embedded instance.
- Registry inspection confirms `@deepseek-ai/dsh-mcp-client` version `0.0.1-rc.1` exists. It supports stdio and Streamable HTTP, discovers MCP tools and registers qualified native names. Its non-text model projection is lossy, so snapshots must preserve a readable local image reference for native image inspection rather than assume MCP image blocks reach the model unchanged. Dependency compatibility still needs validation before installation.

## Architecture
DSH → MCP client adapter → local MCP service → DrawingCanvasHost → embedded Excalidraw engine → existing drawing store. The engine owns current elements and selection. MCP handlers do not construct a second independently persisted scene.

Expose a minimal surface: `get_context`, `read_elements`, `apply_operations`, `render_snapshot`, `restore_checkpoint`. Context includes real drawing/task IDs, a revision token, selected element IDs, viewport and a compact element index. Read operations return requested elements plus necessary bound labels/connectors. Mutations carry the observed revision and operation ID. The renderer validates the complete batch before changing the scene, rejects stale revisions and broken references, and uses supported Excalidraw conversion/mutation APIs rather than inventing internal version fields.

Initial operations cover adding supported shapes, updating text/style/position, connecting real existing elements and deleting explicit elements with their binding cleanup. A successful response includes affected IDs and the new revision. Same operation ID must not apply twice; a transport timeout is an unknown outcome and requires querying the operation, not blind replay.

## Concurrency and restoration
The first implementation uses a strict scene revision check. Manual edits between read and apply cause a conflict response, allowing DSH to reread and replan. Apply one validated batch atomically in the renderer. Persist the actual read-back through the existing saver before acknowledging durable success. Keep a bounded checkpoint for the batch; restoration also checks the current revision so it cannot overwrite later manual work. A save failure reports whether the live scene changed instead of claiming nothing happened.

Do not move the user's viewport or selection during ordinary edits. New-diagram navigation remains explicit. Selection and UI interaction state are live context only and are not persisted in document preferences.

## MCP and DSH integration
Use the supported MCP SDK and inspect available DSH-native client support first. Prefer an existing native client; otherwise implement a small DSH adapter using MCP tool schemas and normal DSH dispatch hooks. Merely registering a new set of direct drawing tools does not satisfy this design. Local HTTP, if used, binds to loopback with per-process authentication and normal client lifecycle cleanup; it does not expose drawing data to an external host. Mutation tools must retain DSH permission review and read-only presets. Tool errors return to the model without aborting recoverable work.

## Interaction
The assistant reads the current drawing and selection when the user asks to adjust “these shapes”. It executes only the requested scope and reports affected elements. One visible revert action restores the last AI batch when no conflicting edit intervened. Image-capable models may inspect snapshots; text-only models can use structured scene data without fabricating visual inspection.

## Verification
Cover a live unsaved selection, editing an existing node and bound text, adding a connector to an existing node, stale-revision rejection with no partial mutation, duplicate request IDs, timeout acknowledgement queries, save failures, checkpoint conflicts, permission denial and tab lifecycle. The end-to-end test must use DSH → real MCP transport → the currently mounted editor, then verify the same persisted drawing after reopening. A second generated canvas or direct mocked tool dispatch is insufficient.
