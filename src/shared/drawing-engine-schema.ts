import { z } from 'zod';

export const drawingEngineId = z.string().min(1).max(4096);
const opId = z.string().min(1).max(128);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const changeFields = {
  x: coordinate.optional(), y: coordinate.optional(),
  width: z.number().positive().max(100_000).optional(), height: z.number().positive().max(100_000).optional(),
  text: z.string().max(10_000).optional(), fontSize: z.number().min(8).max(256).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  strokeColor: z.string().min(1).max(64).optional(), backgroundColor: z.string().min(1).max(64).optional(),
  strokeWidth: z.number().min(0.1).max(20).optional(), opacity: z.number().min(0).max(100).optional(),
  roughness: z.number().min(0).max(3).optional(),
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']).optional(),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
};
export const drawingOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), element: z.object({ ...changeFields, id: opId, type: z.enum(['rectangle', 'ellipse', 'diamond', 'text']), x: coordinate, y: coordinate, containerId: opId.optional() }).strict() }).strict(),
  z.object({ kind: z.literal('update'), id: opId, changes: z.object(changeFields).strict().refine(value => Object.keys(value).length > 0, '修改不能为空') }).strict(),
  z.object({ kind: z.literal('connect'), id: opId, from: opId, to: opId, label: z.string().max(10_000).optional(), strokeColor: z.string().min(1).max(64).optional() }).strict(),
  z.object({ kind: z.literal('delete'), id: opId }).strict(),
]);
export const drawingApplyFields = { drawingId: drawingEngineId, opId, baseRevision: opId, operations: z.array(drawingOperationSchema).min(1).max(100) };
export const drawingRestoreFields = { drawingId: drawingEngineId, opId, baseRevision: opId, checkpointId: opId };
export const drawingOutcomeFields = { drawingId: drawingEngineId, opId, targetOpId: opId };
export const drawingNativeActionFields = { drawingId: drawingEngineId, opId, baseRevision: opId,
  action: z.string().min(1).max(128), elementIds: z.array(opId).max(2000).optional(), value: z.unknown().optional() };
export const drawingEngineCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('apply'), ...drawingApplyFields }).strict(),
  z.object({ kind: z.literal('native-action'), ...drawingNativeActionFields }).strict(),
  z.object({ kind: z.literal('restore'), ...drawingRestoreFields }).strict(),
  z.object({ kind: z.literal('outcome'), ...drawingOutcomeFields }).strict(),
]);
