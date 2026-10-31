# Design

## Baseline evidence
- `drawing_read` reads the file store; live selection is not exposed.
- `applySkeletonBatch` appends elements and checks connector endpoints only within the incoming batch.
- `drawing_save` is whole-scene file replacement, unsuitable for concurrent live editing.
- `DrawingCanvasHost` already handles readiness, request IDs, exports and renderer acknowledgements.
- DSH's current config has no MCP client connection. Existing Excalidraw MCP Apps must not be assumed to control this embedded instance.
- Version-specific registry and installed-source inspection confirms `@deepseek-ai/dsh-mcp-client@0.1.5-rc.2` matches this app's DSH/Cordis peers. It supports Streamable HTTP, discovers schemas and registers native qualified names. Its image admission path saves supported images into durable attachments when the active model declares image input; otherwise it returns an explicit text diagnostic. Snapshots also return the saved local PNG path.

## Implementation evidence
- The app starts the official MCP SDK `1.32.2` server on an ephemeral loopback port, authenticates with a random per-process bearer token and rejects browser Origin headers. The native DSH client is effect-scoped; both sides close on runtime teardown or failed boot.
- Typed IPC targets one mounted renderer and checks acknowledgement ownership. The engine validates the full semantic batch and uses official Excalidraw conversion and `newElementWith`, including existing-node connectors and bound labels.
- The host retains operation outcomes beyond IPC timeouts; `get_operation` can probe the original engine without replaying a mutation. Checkpoints retain the latest 3 snapshots (5 MB scene cap); operation caches reject capacity exhaustion rather than silently evicting IDs and risking duplicate execution.
- A rejected/conflicting edit does not cancel pending manual autosave. Only a validated batch about to mutate cancels that older timer, then explicitly saves actual engine read-back before durable acknowledgement.
- `tests/unit/drawing-live-engine.spec.ts` uses the real Excalidraw converter and binding implementation. `tests/unit/drawing-mcp-server.spec.ts` uses the real SDK and native DSH client/registry over HTTP. `tests/e2e/live-drawing-mcp.spec.ts` uses a scripted model endpoint with the real DSH agent loop, native MCP client, HTTP transport, mounted editor and task file store; it covers duplicate operations, stale revisions, manual edits during model reasoning, UI restoration, persisted reopen and read-only denial followed by continued model output.

## Architecture
The user's clarified goal is human/AI co-writing; MCP is an internal transport choice, not a requirement to adopt the official MCP App or a second canvas. The official repository is implementation reference only and is not a runtime dependency. Reuse the current task editor and file association.

Before each model step, a scoped DSH runtime-context hook queries the editor instance bound when the interactive turn begins. Refresh does not require an AI tool call, start another turn, or wait for autosave. Include bounded actual element summaries and change IDs for text, styles, geometry, additions/removals and selection. Pin webContents ownership and a mount generation; closing/reopening or focusing another window cannot silently replace the target. Background automation turns bind no foreground canvas. A failed read explicitly invalidates context. Inject document text through a prompt variable (substitution is not rescanned) so literal template syntax cannot become prompt instructions or unknown-variable errors. Already in-flight model requests cannot be updated retroactively; stale mutation revision checks remain necessary.

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
