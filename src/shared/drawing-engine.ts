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

/** A small semantic editing surface. Internal Excalidraw fields are never model input. */
export interface DrawingElementChanges {
  x?: number; y?: number; width?: number; height?: number; text?: string;
  fontSize?: number; strokeColor?: string; backgroundColor?: string;
  strokeWidth?: number; opacity?: number; roughness?: number;
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag';
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
}
export type DrawingOperation =
  | { kind: 'add'; element: DrawingElementChanges & { id: string; type: 'rectangle' | 'ellipse' | 'diamond' | 'text'; x: number; y: number } }
  | { kind: 'update'; id: string; changes: DrawingElementChanges }
  | { kind: 'connect'; id: string; from: string; to: string; label?: string; strokeColor?: string }
  | { kind: 'delete'; id: string };
export type DrawingEngineCommand = DrawingContextRequest & (
  | { kind: 'apply'; baseRevision: string; operations: DrawingOperation[] }
  | { kind: 'restore'; baseRevision: string; checkpointId: string }
  | { kind: 'outcome'; targetOpId: string }
);
export interface DrawingEngineResult extends DrawingContextRequest {
  ok: boolean;
  state: 'completed' | 'pending' | 'unknown';
  code?: 'invalid' | 'conflict' | 'save_failed' | 'unavailable' | 'unknown_outcome' | 'capacity' | 'apply_failed';
  error?: string;
  /** Durable refers to the acknowledged file write, not merely the live canvas. */
  durable?: boolean;
  liveChanged?: boolean;
  revision?: string;
  affectedIds?: string[];
  checkpointId?: string;
}
