export interface LiveDrawingContext {
  drawingId: string;
  revision: string;
  elements: unknown[];
  selectedElementIds: string[];
  viewport: { scrollX: number; scrollY: number; zoom: number; width: number; height: number };
}
export interface DrawingContextRequest { drawingId: string; opId: string }
export type DrawingContextResult = DrawingContextRequest & (
  { ok: true; context: LiveDrawingContext } | { ok: false; error: string }
);
