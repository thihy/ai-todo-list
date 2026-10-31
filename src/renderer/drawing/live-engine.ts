import { convertToExcalidrawElements, newElementWith, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { drawingEngineCommandSchema } from '../../shared/drawing-engine-schema';
import type { DrawingElementChanges, DrawingEngineCommand, DrawingEngineResult, DrawingOperation } from '../../shared/drawing-engine';
import type { MinimalExcalidrawApi, SceneSaver } from './apply';
import { readLiveDrawingContext } from './live-context';
import { drawingDocumentState } from './scene-state';
import { validateNativeActionValue } from '../../shared/drawing-native-actions';

type Element = ExcalidrawElement;
type RecordElement = Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number };
const record = (element: Element) => element as unknown as RecordElement;
const clone = <T,>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const update = (element: Element, changes: Record<string, unknown>): Element => newElementWith(element, changes as never);
const convert = (skeletons: unknown[]): Element[] => convertToExcalidrawElements(skeletons as never, { regenerateIds: false });
const shapeTypes = new Set(['rectangle', 'ellipse', 'diamond']);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Centre-to-perimeter ray, in the node's own coordinates, including rotation. */
function endpoint(node: Element, other: Element): [number, number] {
  const angle = node.angle || 0;
  const dx = other.x + other.width / 2 - node.x - node.width / 2;
  const dy = other.y + other.height / 2 - node.y - node.height / 2;
  if (Math.hypot(dx, dy) < 1) throw Error('连线节点中心重叠，请先移动节点');
  const x = dx * Math.cos(angle) + dy * Math.sin(angle);
  const y = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const rx = Math.max(node.width / 2, 1), ry = Math.max(node.height / 2, 1);
  const scale = node.type === 'ellipse' ? 1 / Math.hypot(x / rx, y / ry)
    : node.type === 'diamond' ? 1 / (Math.abs(x) / rx + Math.abs(y) / ry)
      : Math.min(rx / Math.abs(x || 1e-9), ry / Math.abs(y || 1e-9));
  const gap = 8 / Math.max(Math.hypot(x, y), 1);
  return [node.x + node.width / 2 + dx * (scale + gap), node.y + node.height / 2 + dy * (scale + gap)];
}

/** Prepare in isolated copies. No engine calls until every operation has passed. */
export function prepareDrawingOperations(before: Element[], operations: DrawingOperation[]): Element[] {
  const elements = new Map(before.map(element => [element.id, element]));
  const changedGeometry = new Set<string>();
  const get = (key: string): Element => {
    const element = elements.get(key);
    if (!element) throw Error(`绘图元素不存在：${key}`);
    if (element.locked) throw Error(`绘图元素已锁定：${key}`);
    return element;
  };
  const put = (value: Element) => elements.set(value.id, value);
  const revise = (key: string, changes: Record<string, unknown>) => {
    const previous = elements.get(key);
    if (!previous) throw Error(`绘图元素不存在：${key}`);
    const differences = Object.fromEntries(Object.entries(changes).filter(([field, value]) => !equal(record(previous)[field], value)));
    if (Object.keys(differences).length) { get(key); put(update(previous, differences)); }
  };
  const labelFor = (element: Element) => [...elements.values()].find(value => value.type === 'text' && value.containerId === element.id);
  const editText = (target: Element, textChanges: DrawingElementChanges, newLabelId?: string): void => {
    if (target.type === 'text' && target.containerId) {
      const container = get(target.containerId);
      editText(container, textChanges);
      return;
    }
    if (target.type === 'text') {
      const definedChanges = Object.fromEntries(Object.entries(textChanges).filter(([, value]) => value !== undefined));
      const skeleton = { ...record(target), ...definedChanges, originalText: textChanges.text ?? target.originalText };
      delete (skeleton as Partial<RecordElement>).width;
      delete (skeleton as Partial<RecordElement>).height;
      const converted = convert([skeleton])[0];
      if (!converted || converted.type !== 'text') throw Error('文本转换失败');
      revise(target.id, { text: converted.text, originalText: converted.originalText, width: converted.width, height: converted.height, fontSize: converted.fontSize, textAlign: converted.textAlign, verticalAlign: converted.verticalAlign });
      return;
    }
    if (!shapeTypes.has(target.type) && target.type !== 'arrow') throw Error(`此元素不支持绑定文字：${target.id}`);
    const label = labelFor(target);
    if (textChanges.text === '') {
      if (label) { get(label.id); elements.delete(label.id); }
      revise(target.id, { boundElements: target.boundElements?.filter(value => value.type !== 'text') ?? [] });
      return;
    }
    const { boundElements, ...container } = record(target);
    const labelText = textChanges.text ?? (label?.type === 'text' ? label.originalText : '');
    const result = convert([{ ...container, boundElements: (boundElements as Array<{ id: string; type: string }> | null)?.filter(value => value.type !== 'text') ?? [],
      label: { ...(label ? record(label) : {}),
        ...Object.fromEntries(Object.entries(textChanges).filter(([key, value]) => ['textAlign', 'verticalAlign', 'strokeColor', 'opacity'].includes(key) && value !== undefined)),
        id: label?.id ?? newLabelId ?? crypto.randomUUID(), text: labelText, originalText: labelText, fontSize: textChanges.fontSize ?? (label?.type === 'text' ? label.fontSize : 20) } }]);
    const convertedContainer = result.find(value => value.id === target.id);
    const convertedLabel = result.find(value => value.type === 'text' && value.containerId === target.id);
    if (!convertedContainer || !convertedLabel) throw Error('绑定文字转换失败');
    revise(target.id, { width: convertedContainer.width, height: convertedContainer.height, boundElements: convertedContainer.boundElements });
    changedGeometry.add(target.id);
    if (label) revise(label.id, { ...record(convertedLabel), id: label.id });
    else put(convertedLabel);
  };

  for (const operation of operations) {
    if (operation.kind === 'add') {
      if (elements.has(operation.element.id)) throw Error(`绘图元素 id 已存在：${operation.element.id}`);
      const { text, fontSize, textAlign, verticalAlign, containerId, ...base } = operation.element;
      if (containerId) {
        if (base.type !== 'text') throw Error('containerId 只适用于新增绑定文字');
        const container = get(containerId);
        if (labelFor(container)) throw Error('容器已有绑定文字，请 update 该容器的 text，不能重复添加');
        if (!text) throw Error('新增绑定文字不能为空');
        editText(container, { text, fontSize, textAlign, verticalAlign, strokeColor: base.strokeColor, opacity: base.opacity }, base.id);
        continue;
      }
      const skeleton = base.type === 'text' ? { ...base, text: text ?? '', fontSize, textAlign, verticalAlign } : { ...base, ...(text ? { label: { text, fontSize, textAlign, verticalAlign } } : {}) };
      for (const element of convert([skeleton])) {
        if (elements.has(element.id)) throw Error(`转换产生重复元素 id：${element.id}`);
        put(element);
      }
    } else if (operation.kind === 'update') {
      const target = get(operation.id);
      if (!shapeTypes.has(target.type) && target.type !== 'text' && target.type !== 'arrow') throw Error(`暂不支持修改此元素类型：${target.type}`);
      const { text, fontSize, textAlign, verticalAlign, ...changes } = operation.changes;
      if (target.type === 'arrow' && ['x', 'y', 'width', 'height'].some(key => key in changes)) throw Error('请通过修改端点节点来调整绑定连线');
      if (target.type === 'text' && target.containerId && ['x', 'y', 'width', 'height'].some(key => key in changes)) throw Error('请移动文字所属的容器');
      if (target.type === 'text' && ('width' in changes || 'height' in changes)) throw Error('文字大小由内容和字号决定');
      revise(target.id, changes);
      if (['x', 'y', 'width', 'height'].some(key => key in changes)) changedGeometry.add(target.id);
      const current = get(target.id);
      if (text !== undefined || fontSize !== undefined || textAlign !== undefined || verticalAlign !== undefined || (labelFor(current) && changedGeometry.has(current.id))) {
        editText(current, { text, fontSize, textAlign, verticalAlign });
        changedGeometry.add(target.id);
      }
    } else if (operation.kind === 'connect') {
      if (elements.has(operation.id)) throw Error(`绘图元素 id 已存在：${operation.id}`);
      const from = get(operation.from), to = get(operation.to);
      if (from.id === to.id) throw Error('不能将节点连接到自身');
      if (!shapeTypes.has(from.type) || !shapeTypes.has(to.type)) throw Error('连线端点必须是矩形、椭圆或菱形节点');
      const start = endpoint(from, to), end = endpoint(to, from);
      if (!start.every(Number.isFinite) || !end.every(Number.isFinite) || Math.hypot(start[0] - end[0], start[1] - end[1]) < 1) throw Error('连线节点重叠，请先移动节点');
      const result = convert([
        clone(record(from)), clone(record(to)),
        { id: operation.id, type: 'arrow', x: start[0], y: start[1], points: [[0, 0], [end[0] - start[0], end[1] - start[1]]],
          start: { ...record(from), id: from.id }, end: { ...record(to), id: to.id }, strokeColor: operation.strokeColor,
          ...(operation.label ? { label: { text: operation.label } } : {}) },
      ]);
      for (const element of result) {
        if (element.id === from.id || element.id === to.id) revise(element.id, { boundElements: element.boundElements });
        else put(element);
      }
    } else {
      const target = get(operation.id);
      const label = labelFor(target);
      if (label) get(label.id);
      elements.delete(target.id);
      if (label) elements.delete(label.id);
    }
  }

  // Relink arrows after moving their real nodes. Native conversion calculates binding metadata.
  for (const arrow of [...elements.values()]) {
    if (arrow.type !== 'arrow') continue;
    const from = arrow.startBinding && elements.get(arrow.startBinding.elementId);
    const to = arrow.endBinding && elements.get(arrow.endBinding.elementId);
    if (!(from && changedGeometry.has(from.id)) && !(to && changedGeometry.has(to.id))) continue;
    get(arrow.id);
    if ((from && !shapeTypes.has(from.type)) || (to && !shapeTypes.has(to.type)) || record(arrow).elbowed) throw Error(`暂不支持自动调整此连线：${arrow.id}`);
    const points = arrow.points.map(point => [point[0] + arrow.x, point[1] + arrow.y]);
    if (from) points[0] = endpoint(from, to ?? { x: points.at(-1)![0], y: points.at(-1)![1], width: 0, height: 0 } as Element);
    if (to) points[points.length - 1] = endpoint(to, from ?? { x: points[0]![0], y: points[0]![1], width: 0, height: 0 } as Element);
    const origin = points[0]!;
    const anchors = [from, to].filter((value): value is Element => !!value);
    const result = convert([...new Map(anchors.map(value => [value.id, clone(record(value))])).values(),
      { ...record(arrow), x: origin[0], y: origin[1], points: points.map(point => [point[0]! - origin[0]!, point[1]! - origin[1]!]), startBinding: null, endBinding: null,
        ...(from ? { start: record(from) } : {}), ...(to ? { end: record(to) } : {}) },
    ]);
    const converted = result.find(value => value.id === arrow.id);
    if (!converted || converted.type !== 'arrow') throw Error(`连线转换失败：${arrow.id}`);
    revise(arrow.id, { x: converted.x, y: converted.y, points: converted.points, width: converted.width, height: converted.height, startBinding: converted.startBinding, endBinding: converted.endBinding });
    if (labelFor(arrow)) editText(get(arrow.id), {});
  }

  // Delete only the requested nodes and their owned labels; detach surviving references.
  for (const element of [...elements.values()]) {
    const changes: Record<string, unknown> = {};
    if (element.boundElements) changes.boundElements = element.boundElements.filter(value => elements.has(value.id));
    if (element.frameId && !elements.has(element.frameId)) changes.frameId = null;
    if (element.type === 'arrow') {
      if (element.startBinding && !elements.has(element.startBinding.elementId)) changes.startBinding = null;
      if (element.endBinding && !elements.has(element.endBinding.elementId)) changes.endBinding = null;
    }
    revise(element.id, changes);
  }
  return [...elements.values()];
}

interface Checkpoint { id: string; elements: Element[]; afterRevision: string }
/** One editor owns this instance. Main also retains acknowledgements across editor lifetimes. */
export class LiveDrawingEngine {
  private readonly outcomes = new Map<string, { fingerprint: string; promise: Promise<DrawingEngineResult>; result?: DrawingEngineResult }>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private busy = false;

  constructor(private readonly api: MinimalExcalidrawApi, private readonly drawingId: string, private readonly save: SceneSaver, private readonly beforeMutation?: () => void) {}

  execute(input: DrawingEngineCommand): Promise<DrawingEngineResult> {
    const failure = (code: DrawingEngineResult['code'], error: string): DrawingEngineResult => ({ drawingId: this.drawingId, opId: input.opId, ok: false, state: 'completed', code, error, liveChanged: false });
    const parsed = drawingEngineCommandSchema.safeParse(input);
    if (!parsed.success || input.drawingId !== this.drawingId) return Promise.resolve(failure('invalid', parsed.success ? '绘图不匹配' : parsed.error.message));
    if (input.kind === 'outcome') {
      const known = this.outcomes.get(input.targetOpId);
      return Promise.resolve(known?.result ?? { drawingId: this.drawingId, opId: input.targetOpId, ok: false, state: known ? 'pending' : 'unknown', code: 'unknown_outcome', error: known ? '操作仍在执行，请查询相同 opId，勿重放修改' : '没有此操作记录，请重新读取画布核实，勿盲目重放修改' });
    }
    const fingerprint = JSON.stringify(parsed.data);
    const previous = this.outcomes.get(input.opId);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(failure('invalid', '此 opId 已用于不同操作'));
    if (this.outcomes.size >= 256) return Promise.resolve(failure('capacity', '当前画布操作记录已满，请保存并重新打开画布'));
    if (this.busy) return Promise.resolve(failure('conflict', '当前画布有修改正在保存，请等待并重新读取版本'));
    this.busy = true;
    const entry = { fingerprint, promise: Promise.resolve(failure('unavailable', '操作尚未开始')), result: undefined as DrawingEngineResult | undefined };
    this.outcomes.set(input.opId, entry);
    entry.promise = this.mutate(parsed.data as Exclude<DrawingEngineCommand, { kind: 'outcome' }>).catch(cause => failure('apply_failed', message(cause))).then(result => { entry.result = result; return result; }).finally(() => { this.busy = false; });
    return entry.promise;
  }

  private async mutate(command: Exclude<DrawingEngineCommand, { kind: 'outcome' }>): Promise<DrawingEngineResult> {
    const result: DrawingEngineResult = { drawingId: this.drawingId, opId: command.opId, ok: false, state: 'completed', liveChanged: false, durable: false };
    let liveChanged = false;
    try {
      const context = await readLiveDrawingContext(this.api, this.drawingId);
      if (context.revision !== command.baseRevision || !equal(context.elements, this.api.getSceneElements())) return { ...result, code: 'conflict', error: '画布已经变化，请重新读取当前版本后再修改' };
      const state = this.api.getAppState();
      if (state.isDragging || state.isResizing || state.isRotating || (command.kind !== 'native-action' && (state.editingTextElement || state.editingLinearElement))) return { ...result, code: 'conflict', error: '用户正在编辑画布，请稍后重新读取' };
      const before = context.elements as Element[];
      if (JSON.stringify(before).length > 5_000_000) return { ...result, code: 'capacity', error: '当前场景超过撤销快照容量，未应用修改' };
      let after: Element[];
      let nativeError: string | undefined;
      if (command.kind === 'native-action') {
        if (!this.api.executeNativeAction || !this.api.getNativeActions) return { ...result, code: 'unavailable', error: '原生动作桥接不可用，请更新应用' };
        if (!this.api.getNativeActions().some(action => action.name === command.action)) return { ...result, code: 'invalid', error: `引擎未注册此动作：${command.action}，请读取 get_actions 清单` };
        const value = validateNativeActionValue(command.action, command.value);
        const previousSelection = clone((state.selectedElementIds ?? {}) as Record<string, boolean>);
        const previousGroups = clone((state.selectedGroupIds ?? {}) as Record<string, boolean>);
        if (command.action === 'goToCollaborator' && (value as { socketId?: string }).socketId && !(state.collaborators instanceof Map && state.collaborators.has((value as { socketId: string }).socketId))) return { ...result, code: 'invalid', error: '协作者不存在，不能猜测协作者 ID' };
        if (command.elementIds) {
          const wanted = new Set(command.elementIds);
          if ([...wanted].some(id => !before.some(element => element.id === id))) return { ...result, code: 'invalid', error: '目标元素已不存在，请重新读取实时画布' };
          const groups = new Set(before.filter(element => wanted.has(element.id)).flatMap(element => element.groupIds));
          const selectedGroupIds = Object.fromEntries([...groups].filter(group => before.filter(element => element.groupIds.includes(group) && !(element.type === 'text' && element.containerId)).every(element => wanted.has(element.id))).map(group => [group, true]));
          this.api.updateScene({ appState: { selectedElementIds: Object.fromEntries([...wanted].map(id => [id, true])), selectedGroupIds }, captureUpdate: CaptureUpdateAction.NEVER });
          const requested = [...wanted].sort();
          const selectionCommitted = () => equal(Object.entries((this.api.getAppState().selectedElementIds ?? {}) as Record<string, boolean>).filter(([, selected]) => selected).map(([id]) => id).sort(), requested);
          // React's class state can commit after the first animation frame. Do not
          // execute a native action against the preceding selection in that gap.
          for (let attempt = 0; !selectionCommitted() && attempt < 30; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (!selectionCommitted()) return { ...result, code: 'conflict', error: '引擎尚未接受目标选区，请重新读取后再执行动作' };
        }
        try { result.nativeAction = { name: command.action, result: await this.api.executeNativeAction(command.action, value) }; }
        catch (cause) { nativeError = message(cause); result.nativeAction = { name: command.action, error: nativeError }; }
        const keepsSelection = /^(change|align|distribute|flip)/.test(command.action)
          || ['copy', 'copyAsPng', 'copyAsSvg', 'copyText', 'copyStyles', 'pasteStyles', 'bindText', 'unbindText', 'autoResize', 'increaseFontSize', 'decreaseFontSize'].includes(command.action);
        if (command.elementIds && keepsSelection) {
          const selected = (map: Record<string, boolean>) => Object.keys(map).filter(id => map[id]).sort();
          const currentSelection = (this.api.getAppState().selectedElementIds ?? {}) as Record<string, boolean>;
          if (equal(selected(currentSelection), [...new Set(command.elementIds)].sort()) && !equal(selected(currentSelection), selected(previousSelection))) {
            this.api.updateScene({ appState: { selectedElementIds: previousSelection, selectedGroupIds: previousGroups }, captureUpdate: CaptureUpdateAction.NEVER });
            for (let attempt = 0; attempt < 30 && !equal(selected((this.api.getAppState().selectedElementIds ?? {}) as Record<string, boolean>), selected(previousSelection)); attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          }
        }
        after = clone(this.api.getSceneElements()) as Element[];
        liveChanged = !equal(before, after);
        if (command.action === 'paste' && !liveChanged && !result.nativeAction?.result?.ui.pasteDialog && !nativeError) nativeError = '剪贴板未产生可粘贴内容，画布未改变，请检查剪贴板后重试';
      } else if (command.kind === 'restore') {
        const checkpoint = this.checkpoints.get(command.checkpointId);
        if (!checkpoint) return { ...result, code: 'invalid', error: '撤销快照已失效或不属于当前画布' };
        if (checkpoint.afterRevision !== context.revision) return { ...result, code: 'conflict', error: 'AI 修改后画布已有其他变化，不能覆盖后续编辑' };
        const current = new Map(before.map(element => [element.id, element]));
        after = checkpoint.elements.map(element => equal(current.get(element.id), element) ? current.get(element.id)! : newElementWith(current.get(element.id) ?? element, clone(record(element)) as never, true));
      } else after = prepareDrawingOperations(before, command.operations);
      const checkpointId = crypto.randomUUID();
      this.beforeMutation?.();
      if (command.kind !== 'native-action') this.api.updateScene({ elements: after, captureUpdate: CaptureUpdateAction.NEVER });
      const actual = clone(this.api.getSceneElements()) as Element[];
      liveChanged = !equal(before, actual);
      if (!equal(after.map(element => element.id), actual.map(element => element.id))) throw Error('画布未完整应用元素修改');
      if (!equal(before, after) && !liveChanged) throw Error('画布未应用元素修改');
      // Enqueue the real read-back save before yielding to the hash calculation, so a
      // later manual autosave cannot be overwritten by this older snapshot.
      let saveOutcome: Promise<{ ok: true } | { ok: false; cause: unknown }>;
      const actualState = command.kind === 'native-action' ? this.api.getAppState() : state;
      try { saveOutcome = Promise.resolve(this.save(this.drawingId, { elements: actual, appState: drawingDocumentState(actualState), files: this.api.getFiles?.() })).then(() => ({ ok: true as const }), cause => ({ ok: false as const, cause })); }
      catch (cause) { saveOutcome = Promise.resolve({ ok: false, cause }); }
      const appliedContext = await readLiveDrawingContext({ ...this.api, getSceneElements: () => actual, getAppState: () => actualState }, this.drawingId);
      const previous = new Map(before.map(element => [element.id, element]));
      const current = new Map(actual.map(element => [element.id, element]));
      const affectedIds = [...new Set([...previous.keys(), ...current.keys()])].filter(key => !equal(previous.get(key), current.get(key)));
      if (liveChanged) this.checkpoints.set(checkpointId, { id: checkpointId, elements: before, afterRevision: appliedContext.revision });
      if (this.checkpoints.size > 3) this.checkpoints.delete(this.checkpoints.keys().next().value!);
      Object.assign(result, { liveChanged, revision: appliedContext.revision, affectedIds, ...(liveChanged ? { checkpointId } : {}) });
      const saved = await saveOutcome;
      if (!saved.ok) return { ...result, code: 'save_failed', error: `画布已修改，但保存失败：${message(saved.cause)}` };
      if (nativeError) return { ...result, durable: true, code: 'apply_failed', error: nativeError };
      return { ...result, ok: true, durable: true };
    } catch (cause) { return { ...result, liveChanged, code: liveChanged ? 'apply_failed' : 'invalid', error: message(cause) }; }
  }
}
