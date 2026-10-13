// 语义绘图指令 → Excalidraw 骨架元素（纯函数，main 进程可跑）。
//
// 这里只做**排版**，不碰 Excalidraw 的元素字段：versionNonce / seed /
// version / index / boundElements 这些由渲染进程的官方
// convertToExcalidrawElements 补齐。本文件刻意不 import @excalidraw/
// excalidraw —— 那个包的运行时入口是浏览器 bundle，main 里 import 会炸。
//
// 排版规则（确定性，无随机）：
//   - 每个节点占一个栅格格，列间距 COL_GAP + 节点宽，行间距 ROW_GAP + 节点高
//   - 同一格多个节点 → 从该格原点往下依次堆叠（模型不用操心间距）
//   - 缺 column/row 的节点按出现顺序排在已有格之后，不会静默重叠
//   - 箭头从起点右缘连到终点左缘；终点在起点左边时绕行成三段折线

import type {
  DrawingDrawSpec,
  DrawingEdgeSpec,
  DrawingNodeSpec,
  DrawingSkeleton,
} from '../../shared/drawing-spec';

/** 容器默认尺寸。菱形要装下同样的字，所以更大。 */
const CONTAINER_W = 180;
const CONTAINER_H = 60;
const DIAMOND_W = 200;
const DIAMOND_H = 100;
const TEXT_LINE_H = 30;
/** 一个中文字约 14px 宽，用来估纯文字节点的宽度。 */
const CHAR_W = 14;

const COL_GAP = 80;
const ROW_GAP = 40;
/** 文字节点的外边距，避免贴到格子边缘。 */
const TEXT_PAD = 12;

/** 估算一段文字在容器里需要的宽度（按字数线性估，不做真实测量）。 */
function estimateTextWidth(text: string): number {
  // 中文按 1 个字宽、ASCII 按 0.55 个字宽粗估。
  let units = 0;
  for (const ch of text) units += /[\x00-\x7f]/.test(ch) ? 0.55 : 1;
  return Math.max(MIN_TEXT_W, Math.ceil(units * CHAR_W));
}

const MIN_TEXT_W = 60;
const MAX_TEXT_W = 320;

/** 容器 / 文字节点该占多大。所有宽度都有 MAX_TEXT_W 上限 —— 少了它，一段
 *  长说明文字会把容器撑到几千像素宽，画布上变成一条横线。 */
function sizeOf(node: DrawingNodeSpec): { width: number; height: number } {
  const text = (node.text ?? '').trim();
  const measured = Math.min(MAX_TEXT_W, estimateTextWidth(text));
  if (node.kind === 'text') {
    return {
      width: Math.min(MAX_TEXT_W, measured + TEXT_PAD * 2),
      height: TEXT_LINE_H,
    };
  }
  if (node.kind === 'diamond') {
    // 菱形内接文字，横向要更宽才不溢出。
    return { width: Math.max(DIAMOND_W, measured + TEXT_PAD * 3), height: DIAMOND_H };
  }
  return {
    width: Math.max(CONTAINER_W, measured + TEXT_PAD * 2),
    height: CONTAINER_H,
  };
}

/** 布局失败的显式原因，交给上层变成给模型看的错误文案。 */
export class DrawingSpecError extends Error {}

interface Placed {
  id: string;
  key: string;
  node: DrawingNodeSpec;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素 id 不能和 Excalidraw 的内部约定撞车，也别和模型给的 key 混淆。 */
function elementIdFor(index: number): string {
  return `ai-node-${index}`;
}

/**
 * 校验 + 排版。返回可以直接喂给 convertToExcalidrawElements 的骨架数组。
 * 校验失败抛 DrawingSpecError —— 调用方负责把它变成模型读得懂的提示。
 */
export function layoutDrawingSpec(spec: DrawingDrawSpec): DrawingSkeleton[] {
  const nodes = spec?.nodes ?? [];
  const edges = spec?.edges ?? [];
  if (nodes.length === 0) {
    throw new DrawingSpecError('nodes 为空：至少要有一个节点才能画。');
  }
  if (nodes.length > 200) {
    throw new DrawingSpecError(`节点过多（${nodes.length}）：单次最多 200 个。`);
  }

  // --- 校验 key 唯一 ---
  const keyToId = new Map<string, string>();
  nodes.forEach((node, i) => {
    const key = (node?.key ?? '').trim();
    if (!key) throw new DrawingSpecError(`第 ${i + 1} 个节点缺少 key。`);
    if (keyToId.has(key)) throw new DrawingSpecError(`节点 key 重复：${key}`);
    keyToId.set(key, elementIdFor(i));
  });

  // --- 排版 ---
  //
  // 两趟，顺序不能反：
  //   1) 按 row 分组、行号升序，确定每一行的起始 y（= 前面所有行占掉的高度）。
  //      这一步只看行，不看列 —— 同一行的所有列共享同一个起始 y。
  //   2) 行内按 column 分桶，同一 column 的多个节点纵向堆叠。
  //
  // 之前把 (row,column) 当成单个桶、并用 rowBottom 累加，同一行的不同列会
  // 互相把对方推到下一行去（列 1 被挤到 y=height，跑到列 0 下面）。所以这里
  // 必须先按行聚合，再在行内分列。
  const byRow = new Map<number, Map<number, DrawingNodeSpec[]>>();
  for (const node of nodes) {
    const col = Number.isFinite(node.column) ? Math.max(0, Math.trunc(node.column)) : 0;
    const row = Number.isFinite(node.row) ? Math.max(0, Math.trunc(node.row)) : 0;
    let columns = byRow.get(row);
    if (!columns) {
      columns = new Map<number, DrawingNodeSpec[]>();
      byRow.set(row, columns);
    }
    const column = columns.get(col);
    if (column) column.push(node);
    else columns.set(col, [node]);
  }

  const placed = new Map<string, Placed>();
  const rowNumbers = [...byRow.keys()].sort((a, b) => a - b);
  let rowTop = 0;
  for (const row of rowNumbers) {
    const columns = byRow.get(row)!;
    // 这一行最高要占多高（行内同列堆叠的最大高度）。
    let rowHeight = 0;
    for (const columnNodes of columns.values()) {
      let y = rowTop;
      for (const node of columnNodes) {
        const size = sizeOf(node);
        placed.set(node.key.trim(), {
          id: keyToId.get(node.key.trim())!,
          key: node.key.trim(),
          node,
          x: 0, // 下面统一填
          y,
          width: size.width,
          height: size.height,
        });
        y += size.height + ROW_GAP;
      }
      rowHeight = Math.max(rowHeight, y - rowTop);
    }
    rowTop += rowHeight;
    // 行内按列号升序摆 x。
    for (const col of [...columns.keys()].sort((a, b) => a - b)) {
      const x = col * (COL_GAP + CONTAINER_W);
      for (const node of columns.get(col)!) {
        const p = placed.get(node.key.trim())!;
        placed.set(node.key.trim(), { ...p, x });
      }
    }
  }

  // --- 节点骨架 ---
  const skeletons: DrawingSkeleton[] = [];
  for (const p of placed.values()) {
    const text = (p.node.text ?? '').trim();
    const base = {
      id: p.id,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
    };
    if (p.node.kind === 'text') {
      skeletons.push({
        ...base,
        type: 'text',
        // 纯文字没有 label 包装，文字直接进 text 字段由渲染进程展开。
        label: text ? { text } : undefined,
      } as DrawingSkeleton);
      continue;
    }
    skeletons.push({
      ...base,
      type: p.node.kind,
      label: text ? { text } : undefined,
    } as DrawingSkeleton);
  }

  // --- 边（箭头）---
  for (const edge of edges) {
    const from = placed.get((edge?.from ?? '').trim());
    const to = placed.get((edge?.to ?? '').trim());
    if (!from) throw new DrawingSpecError(`边的 from 找不到节点：${edge?.from}`);
    if (!to) throw new DrawingSpecError(`边的 to 找不到节点：${edge?.to}`);
    skeletons.push(buildArrow(from, to, edge));
  }

  return skeletons;
}

/** 从起点右缘连到终点左缘；终点在左边时绕成三段折线。 */
function buildArrow(from: Placed, to: Placed, edge: DrawingEdgeSpec): DrawingSkeleton {
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const ex = to.x;
  const ey = to.y + to.height / 2;

  const x = sx;
  const y = sy;
  let points: number[][];
  if (ex >= sx) {
    // 正向：一条水平线，折线不需要中间点。
    points = [
      [0, 0],
      [ex - sx, ey - sy],
    ];
  } else {
    // 回指：从起点先向右让开一点，再折回终点，避免和节点重叠。
    const midX = 30;
    points = [
      [0, 0],
      [midX, 0],
      [midX, ey - sy],
      [ex - sx, ey - sy],
    ];
  }

  const labelText = (edge.label ?? '').trim();
  return {
    type: 'arrow',
    id: `ai-edge-${from.id}-${to.id}`,
    x,
    y,
    width: Math.abs(ex - sx),
    height: Math.abs(ey - sy),
    points,
    start: { id: from.id },
    end: { id: to.id },
    label: labelText ? { text: labelText } : undefined,
  };
}