## Decisions
Keep file bytes in the composer inbox and submit paths to DSH read_image. Allow an empty text draft when settled attachments exist. Preview URLs use the existing attachment scheme with a reserved composer host and an encoded basename; main checks the index and real path containment before serving raster bytes. Historical messages retain their existing metadata and gain the same preview component.

## Validation
Cover image-only immediate submission, registered preview reads, path rejection and deleted files. Run image plumbing and paste regressions, typecheck and production build.

## Local model configuration
The active custom model alias `thihy` lacked supportsImageInput, so the existing fail-closed capability gate treated it as text-only. The user confirmed vision support and authorized enabling that field in the local application config. Repository defaults remain conservative for unknown models.

## Runtime verification
The installed application lacked the switch and read_image registration; its single-instance lock initially prevented launching the source build. After exiting it normally, the source build exposed the enabled checkbox. Startup revealed drawing_draw nested object schemas missing additionalProperties; declaring false restored DSH boot.

A generated 320x240 raster fixture was pasted through the actual composer. Both composer and sent-turn previews loaded, and image-only submission was enabled. A temporary local OpenAI-compatible fixture requested read_image and observed a PNG data URL in the following request. The fixture was stopped and the original thihy configuration restored. The real gateway returned HTTP 500 VIRTUAL_MODEL_NO_BACKENDS, so actual model vision inference remains unverified until that route has an available backend.

## Follow-up corrections
Restoring settings did not change an existing agent's cached model or persisted request header, leaving the test conversation bound to local-vision-debug. Each agent now owns DSH's installModelSelection contributions; its current selection updates after the previous turn releases, so cached and resumed histories both use current settings without interrupting an active turn. Runtime verification resumed that exact conversation with recovery-a, then removed that model and sent again with recovery-b; both local requests succeeded with the correct model. Original thihy settings were restored afterward.

Sent images now use aspect-preserving previews up to 280x240 with 12px corners and a muted filename beneath, instead of a horizontal capsule. Composer images use compact 104x80 previews with a remove control at the corner.
