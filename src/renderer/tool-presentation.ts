// Renderer-facing re-export of src/shared/tool-presentation.ts. The shared
// module owns the projection logic so the main process can declare
// presentCall / presentResult on every defineTool() and the renderer can
// use the same code as a fallback when the wire does not carry a
// pre-computed view.
//
// This file exists for import-path stability — AIPane (and any other
// renderer consumer) imports from '../tool-presentation'. New consumers
// should import from '@shared/tool-presentation' directly.

export * from '@shared/tool-presentation';