## Approach
Reuse the live canvas readiness handshake. Correlate export requests by operation and drawing ID, with bounded waits and late-result rejection. Excalidraw exportToBlob includes complete scene bounds and binary files, with a white/background-aware light rendering and maximum side 2048 pixels. It does not mutate, select, zoom or save the scene.

The main tool checks the exact calling route's input modalities before producing image content. Save PNG bytes through the shared task-directory resolver under thumbs/{drawingId}.render.png and admit the image through the existing durable attachment service. Return native text and image content blocks, so the image reaches the next provider request without base64 in text or a separate read_image call.

The user may download the same PNG from the editor. Empty, invalid, unavailable and timed-out canvases report explicit failures. Rendering is classified as a read operation; cached PNG is a derived artifact.

## Validation
Test host readiness, correlation, concurrency and timeouts; attachment/image content projection; whole-scene export options and errors. Verify real Electron export bytes and a mock model request containing the rendered image. Run typecheck, relevant tests, production build and repository checks.
