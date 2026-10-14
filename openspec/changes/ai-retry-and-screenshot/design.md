## Decisions
Retry reuses the latest failed turn's payload and intent, replaces its UI attempt with a new invocation id, clears prior attempt output, and leaves the current input draft intact. A ref guards rapid repeat clicks. Existing runtime model selection resolves the current provider/model per admitted turn.

Each explicit retry retains a retryGroupId in IPC and durable user-message source metadata. History folding collapses only matching text within an explicit group; identical unmarked messages remain independent, and assistant/tool attempt traces are retained.

Screenshot capture hides the main window briefly, freezes each display via Electron desktopCapturer, and opens an isolated overlay per display. Windows EnumWindows and DWM visible-frame bounds provide stacking-ordered snap candidates, converted from physical coordinates to display-local DIP. Other platforms retain manual selection. Drag selects or moves a region; click selects a hovered window; Enter/double-click confirms; Escape/right-click cancels. Crop conversion uses actual captured image dimensions, not assumed DPI. Main validates the originating overlay and bounds, saves confirmed PNG bytes to composer inbox, and restores app focus on all terminal paths. Screenshot confirmation does not submit to AI.

## Validation
Cover image retry payload, new invocation ids, preserved drafts and rapid clicks; crop clipping and fractional DPI; overlay sender validation, cancellation, capture errors and confirmed inbox association. Start the app to exercise snapping, manual selection, confirmation, cancellation and failure/retry with a local test endpoint. Restore original provider settings after tests.

## Runtime results
On the live 3440x1440 Windows display, native enumeration returned 11 visible window candidates and hovered over the controlled Edge fixture at exactly its 982x701 visible frame. Confirmation produced a 982x701 PNG attachment. Manual dragging selected 400x300; moving the selection preserved its size, and Enter saved the matching PNG. Esc closed all overlay windows and left the two attachments unchanged. A local endpoint deliberately failed the first screenshot message, then succeeded on retry: one visible user message, two retained attachments, and the unsent draft unchanged. Original thihy settings were restored and the local test service stopped.
