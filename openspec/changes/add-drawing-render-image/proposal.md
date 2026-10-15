## Why
The model can edit scene JSON but cannot judge the resulting layout, overlapping labels or arrow crossings without an actual rendered image.

## What Changes
- Add drawing_render returning a durable image content block directly to vision-capable models.
- Export the full live scene, including unsaved edits, embedded images and offscreen elements, as bounded PNG.
- Save PNG in the task's associated directory and provide a user-facing PNG download.

## Capabilities
### New Capabilities
- `drawing-render-image`: Full-scene image export and model visual inspection.

## Impact
Canvas host/IPC/preload/editor, attachment-backed model tools, tool presentation and persona.
