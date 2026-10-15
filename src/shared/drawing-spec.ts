// AI 绘图指令的共享契约。
//
// 为什么不直接让模型写 Excalidraw scene JSON：每个 element 都要带 id /
// seed / version / versionNonce / index / angle / strokeColor / … 一整套
// 机械字段，其中 versionNonce 每次重算都要变。模型徒手产出这套东西的结果
// 只能是空白画布或非法元素。所以模型只描述**语义**（拓扑 + 文案 + 栅格位置），
// 布局在 main 里算，Excalidraw 的字段由官方 convertToExcalidrawElements 补齐。
//
// 这一层刻意不 import @excalidraw/excalidraw 的类型：那个包的运行时入口是
// 浏览器 bundle，main 进程 import 会炸（roughjs 解析失败）。main 只负责算出
// 下面这些**结构上兼容**的骨架，真正的转换发生在渲染进程。

/** 模型能用的节点形状。`text` 是纯文字（无边框），其余是带边框的容器。 */
export type DrawingNodeKind = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'cylinder';

export interface DrawingNodeSpec {
  /** 模型内部的名字，用于 edges 引用。同一批里必须唯一。 */
  key: string;
  kind: DrawingNodeKind;
  /** 容器内的文字 / 纯文字节点的内容。 */
  text?: string;
  /** 栅格列，从 0 开始，决定水平位置。 */
  column: number;
  /** 栅格行，从 0 开始，决定垂直位置。 */
  row: number;
}

export interface DrawingEdgeSpec {
  /** 起点节点的 key。 */
  from: string;
  /** 终点节点的 key。 */
  to: string;
  /** 箭头上的文字，例如「是」/「否」。 */
  label?: string;
}

export interface DrawingDrawSpec {
  nodes: DrawingNodeSpec[];
  edges: DrawingEdgeSpec[];
}

/**
 * main 布局完之后、发给渲染进程的骨架元素。
 * 形状刻意对齐 Excalidraw 的 ExcalidrawElementSkeleton / ValidLinearElement，
 * 渲染进程可以（且应该）直接丢给 convertToExcalidrawElements，不要再翻译一遍。
 *
 * 注意这里**没有** versionNonce / seed / version / index —— 那正是官方转换
 * 函数负责的部分，我们不去重复实现，也就不会和 Excalidraw 的版本漂移。
 */
export interface DrawingSkeleton {
  type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 容器 / 箭头上的文字。官方转换会为容器自动生成绑定文本元素。 */
  label?: { text: string; fontSize?: number };
  /** 折线 / 箭头。points[0] 恒为 [0,0]，其余是相对起点的偏移。 */
  points?: number[][];
  /** 箭头两端绑定的元素 id（必须是同一批里的节点 id）。 */
  start?: { id: string };
  end?: { id: string };
}

/** main → 渲染进程：把这批骨架追加到画布。 */
export interface DrawingApplyPayload {
  drawingId: string;
  /** 幂等 / 关联用的一次性 id，渲染进程回执时原样带回。 */
  opId: string;
  skeletons: DrawingSkeleton[];
  /** 落盘后是否把视口滚到新内容（AI 新建绘图时为 true）。 */
  scrollToContent?: boolean;
}

/** 渲染进程 → main：画布已挂载、可以接受 apply。 */
export interface DrawingCanvasReadyPayload {
  drawingId: string;
}

/** 渲染进程 → main：apply 执行完毕的回执。 */
export interface DrawingAppliedPayload {
  opId: string;
  drawingId: string;
  ok: boolean;
  error?: string;
}

export interface DrawingExportPayload { opId: string; drawingId: string }
export interface DrawingExportResult extends DrawingExportPayload {
  ok: boolean;
  error?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
}
