# Design

## Context
An isolated live model request reproduces drawing_draw returning 画布尚未就绪 on a cold canvas. Applying to an already loaded canvas succeeds; native Chinese input remains functional in that scenario, so the reported complete input lock is not yet reproduced.

## Decisions
Move canvasReady to the Excalidraw API callback and canvasGone to lifecycle cleanup. Keep a dedicated React root per mounted canvas child, update refreshed scenes through the existing API, and detach only the old child when deferred unmount runs. Keep save callbacks in refs, cancel delayed autosaves on teardown/refresh, and restrict Ctrl+S to targets inside the canvas. Ignore transient dialog/selection/editing state when saving or restoring scene state so external scene data cannot reopen focus-trapping UI.

Use one updateScene object with captureUpdate, matching installed vendor declarations. Validate default IPC saves before acknowledging AI operations. Ensure fallback runtime construction also supplies the canvas host.

## Risks
Cold API initialization can be slower than component mounting; main must wait for API readiness. Scene refresh must not replay stale autosaves or replace an unrelated drawing's scene after async reads.
