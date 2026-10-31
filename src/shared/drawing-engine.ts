export interface LiveDrawingContext {
  drawingId: string;
  revision: string;
  elements: unknown[];
  selectedElementIds: string[];
  viewport: { scrollX: number; scrollY: number; zoom: number; width: number; height: number };
  nativeActions?: NativeDrawingAction[];
}
export interface NativeDrawingAction { name: string; label: string; enabled: boolean; available: boolean; viewMode: boolean }
export interface NativeDrawingActionResult { result: string; ui: Record<string, unknown> }
export interface DrawingContextRequest { drawingId: string; opId: string; includeActions?: boolean }
export type DrawingContextResult = DrawingContextRequest & (
  { ok: true; context: LiveDrawingContext } | { ok: false; error: string }
);

/** A small semantic editing surface. Internal Excalidraw fields are never model input. */
export interface DrawingElementChanges {
  x?: number; y?: number; width?: number; height?: number; text?: string;
  fontSize?: number; strokeColor?: string; backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right'; verticalAlign?: 'top' | 'middle' | 'bottom';
  strokeWidth?: number; opacity?: number; roughness?: number;
  fillStyle?: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag';
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
}
export type DrawingOperation =
  | { kind: 'add'; element: DrawingElementChanges & { id: string; type: 'rectangle' | 'ellipse' | 'diamond' | 'text'; x: number; y: number; containerId?: string } }
  | { kind: 'update'; id: string; changes: DrawingElementChanges }
  | { kind: 'connect'; id: string; from: string; to: string; label?: string; strokeColor?: string }
  | { kind: 'delete'; id: string };
export type DrawingEngineCommand = DrawingContextRequest & (
  | { kind: 'apply'; baseRevision: string; operations: DrawingOperation[] }
  | { kind: 'native-action'; baseRevision: string; action: string; elementIds?: string[]; value?: unknown }
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
  nativeAction?: { name: string; result?: NativeDrawingActionResult; error?: string };
}
