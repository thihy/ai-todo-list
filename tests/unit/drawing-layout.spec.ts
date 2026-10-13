// 语义绘图指令 → 骨架元素的排版 —— 单元测试。
//
// 排版是 AI 画图的**唯一**纯逻辑环节（其余都交给 Excalidraw 官方转换），
// 所以这里要钉死的是：栅格定位、同格堆叠、箭头几何、以及各种非法输入。
//
// 这些断言同时是「模型能拿到的反馈」的设计文档 —— main 会把 DrawingSpecError
// 的 message 原样返回给模型，模型据此纠正下一次调用。

import { describe, expect, it } from 'vitest';

import { layoutDrawingSpec, DrawingSpecError } from '../../src/main/drawing/layout';
import type { DrawingDrawSpec } from '../../src/shared/drawing-spec';

const flow: DrawingDrawSpec = {
  nodes: [
    { key: 'start', kind: 'ellipse', text: '开始', column: 0, row: 0 },
    { key: 'check', kind: 'diamond', text: '通过?', column: 1, row: 0 },
    { key: 'done', kind: 'rectangle', text: '完成', column: 2, row: 0 },
  ],
  edges: [
    { from: 'start', to: 'check' },
    { from: 'check', to: 'done', label: '是' },
  ],
};

const byId = (spec: DrawingDrawSpec) =>
  new Map(layoutDrawingSpec(spec).map((s) => [s.id, s]));

describe('layoutDrawingSpec', () => {
  it('每个节点产出一个骨架，id 稳定且互不相同', () => {
    const out = layoutDrawingSpec(flow);
    expect(out).toHaveLength(5); // 3 节点 + 2 箭头
    const nodeIds = out.filter((s) => s.type !== 'arrow').map((s) => s.id);
    expect(new Set(nodeIds).size).toBe(3);
    expect(nodeIds).toEqual(['ai-node-0', 'ai-node-1', 'ai-node-2']);
  });

  it('同一行按 column 从左到右排开，x 递增', () => {
    const m = byId(flow);
    const start = m.get('ai-node-0')!;
    const check = m.get('ai-node-1')!;
    const done = m.get('ai-node-2')!;
    expect(start.x).toBeLessThan(check.x);
    expect(check.x).toBeLessThan(done.x);
    // 同一行 y 相同。
    expect(start.y).toBe(check.y);
    expect(check.y).toBe(done.y);
  });

  it('不同行 y 不同，行号越大越靠下', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'a', kind: 'rectangle', text: 'A', column: 0, row: 0 },
        { key: 'b', kind: 'rectangle', text: 'B', column: 0, row: 2 },
      ],
      edges: [],
    });
    const m = new Map(out.map((s) => [s.id, s]));
    expect(m.get('ai-node-1')!.y).toBeGreaterThan(m.get('ai-node-0')!.y);
  });

  it('行号跳跃也留出间距：第 3 行不会贴着第 0 行', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'a', kind: 'rectangle', text: 'A', column: 0, row: 0 },
        { key: 'b', kind: 'rectangle', text: 'B', column: 0, row: 3 },
      ],
      edges: [],
    });
    const m = new Map(out.map((s) => [s.id, s]));
    const a = m.get('ai-node-0')!;
    const b = m.get('ai-node-1')!;
    // 至少隔着一个节点的高度，视觉上不会像同一行的两个框。
    expect(b.y).toBeGreaterThan(a.y + a.height);
  });

  it('多行的排布互不重叠', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'a', kind: 'rectangle', text: 'A', column: 0, row: 0 },
        { key: 'b', kind: 'rectangle', text: 'B', column: 0, row: 1 },
        { key: 'c', kind: 'rectangle', text: 'C', column: 1, row: 0 },
        { key: 'd', kind: 'rectangle', text: 'D', column: 1, row: 1 },
      ],
      edges: [],
    });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const p = out[i]!;
        const q = out[j]!;
        const overlapX = p.x < q.x + q.width && q.x < p.x + p.width;
        const overlapY = p.y < q.y + q.height && q.y < p.y + p.height;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('节点不重叠：同行的矩形 x 区间互不相交', () => {
    const m = byId(flow);
    const a = m.get('ai-node-0')!;
    const b = m.get('ai-node-1')!;
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  });

  it('同一格的多个节点纵向堆叠，不重叠', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'a', kind: 'rectangle', text: 'A', column: 0, row: 0 },
        { key: 'b', kind: 'rectangle', text: 'B', column: 0, row: 0 },
        { key: 'c', kind: 'rectangle', text: 'C', column: 0, row: 0 },
      ],
      edges: [],
    });
    const [a, b, c] = out;
    expect(a!.x).toBe(b!.x);
    expect(b!.x).toBe(c!.x);
    expect(b!.y).toBeGreaterThan(a!.y);
    expect(c!.y).toBeGreaterThan(b!.y);
  });

  it('容器带文字时宽度随文字变长，但有上限', () => {
    const short = layoutDrawingSpec({
      nodes: [{ key: 'a', kind: 'rectangle', text: '短', column: 0, row: 0 }],
      edges: [],
    })[0]!;
    const long = layoutDrawingSpec({
      nodes: [
        {
          key: 'a',
          kind: 'rectangle',
          text: '这是一段相当长的说明文字'.repeat(20),
          column: 0,
          row: 0,
        },
      ],
      edges: [],
    })[0]!;
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.width).toBeLessThanOrEqual(400);
  });

  it('菱形比普通容器更大', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'r', kind: 'rectangle', text: 'X', column: 0, row: 0 },
        { key: 'd', kind: 'diamond', text: 'X', column: 1, row: 0 },
      ],
      edges: [],
    });
    const r = out.find((s) => s.type === 'rectangle')!;
    const d = out.find((s) => s.type === 'diamond')!;
    expect(d.width).toBeGreaterThanOrEqual(r.width);
    expect(d.height).toBeGreaterThan(r.height);
  });

  it('纯文字节点没有 label 包装不了的情况 —— 仍产出 text 类型', () => {
    const out = layoutDrawingSpec({
      nodes: [{ key: 't', kind: 'text', text: '备注', column: 0, row: 0 }],
      edges: [],
    });
    expect(out[0]!.type).toBe('text');
  });

  it('箭头绑定到两端的元素 id', () => {
    const out = layoutDrawingSpec(flow);
    const arrows = out.filter((s) => s.type === 'arrow');
    expect(arrows).toHaveLength(2);
    expect(arrows[0]!.start).toEqual({ id: 'ai-node-0' });
    expect(arrows[0]!.end).toEqual({ id: 'ai-node-1' });
  });

  it('箭头的 points[0] 恒为 [0,0]（起点即元素原点）', () => {
    const out = layoutDrawingSpec(flow);
    for (const a of out.filter((s) => s.type === 'arrow')) {
      expect(a.points![0]).toEqual([0, 0]);
      expect(a.points!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('正向箭头是一条直线（两点）', () => {
    const arrow = layoutDrawingSpec(flow).find((s) => s.type === 'arrow')!;
    expect(arrow.points).toHaveLength(2);
  });

  it('回指箭头（终点在左边）绕成折线而不是一条直线', () => {
    const out = layoutDrawingSpec({
      nodes: [
        { key: 'a', kind: 'rectangle', text: 'A', column: 0, row: 0 },
        { key: 'b', kind: 'rectangle', text: 'B', column: 1, row: 0 },
      ],
      edges: [{ from: 'b', to: 'a' }],
    });
    const arrow = out.find((s) => s.type === 'arrow')!;
    expect(arrow.points!.length).toBeGreaterThan(2);
  });

  it('箭头上的 label 被保留', () => {
    const out = layoutDrawingSpec(flow);
    const labeled = out.find((s) => s.type === 'arrow' && s.label);
    expect(labeled!.label!.text).toBe('是');
  });

  it('空白文字不会产出空 label', () => {
    const out = layoutDrawingSpec({
      nodes: [{ key: 'a', kind: 'rectangle', text: '   ', column: 0, row: 0 }],
      edges: [],
    });
    expect(out[0]!.label).toBeUndefined();
  });

  // --- 非法输入：这些 message 会直接回到模型 ---

  it('节点为空时报错', () => {
    expect(() => layoutDrawingSpec({ nodes: [], edges: [] })).toThrow(DrawingSpecError);
    expect(() => layoutDrawingSpec({ nodes: [], edges: [] })).toThrow(/nodes 为空/);
  });

  it('key 缺失 / 重复报错，且指名道姓', () => {
    expect(() =>
      layoutDrawingSpec({ nodes: [{ kind: 'rectangle', column: 0, row: 0 } as never], edges: [] }),
    ).toThrow(/缺少 key/);
    expect(() =>
      layoutDrawingSpec({
        nodes: [
          { key: 'a', kind: 'rectangle', column: 0, row: 0 },
          { key: 'a', kind: 'rectangle', column: 0, row: 0 },
        ],
        edges: [],
      }),
    ).toThrow(/重复/);
  });

  it('边引用了不存在的节点时报错（不静默丢弃这条边）', () => {
    expect(() =>
      layoutDrawingSpec({
        nodes: [{ key: 'a', kind: 'rectangle', column: 0, row: 0 }],
        edges: [{ from: 'a', to: 'ghost' }],
      }),
    ).toThrow(/ghost/);
    expect(() =>
      layoutDrawingSpec({
        nodes: [{ key: 'a', kind: 'rectangle', column: 0, row: 0 }],
        edges: [{ from: 'ghost', to: 'a' }],
      }),
    ).toThrow(/ghost/);
  });

  it('节点数量超限时报错，防止一次画崩画布', () => {
    const nodes = Array.from({ length: 201 }, (_, i) => ({
      key: `n${i}`,
      kind: 'rectangle' as const,
      column: i % 20,
      row: Math.floor(i / 20),
    }));
    expect(() => layoutDrawingSpec({ nodes, edges: [] })).toThrow(/最多 200/);
  });

  it('缺 column/row 的节点退化成第 0 格，而不是 NaN 坐标', () => {
    const out = layoutDrawingSpec({
      nodes: [{ key: 'a', kind: 'rectangle', text: 'A' } as never],
      edges: [],
    });
    expect(Number.isFinite(out[0]!.x)).toBe(true);
    expect(Number.isFinite(out[0]!.y)).toBe(true);
  });

  it('负数 row/column 被夹到 0，不会画出负坐标', () => {
    const out = layoutDrawingSpec({
      nodes: [{ key: 'a', kind: 'rectangle', column: -5, row: -3 }],
      edges: [],
    });
    expect(out[0]!.x).toBeGreaterThanOrEqual(0);
    expect(out[0]!.y).toBeGreaterThanOrEqual(0);
  });

  it('同一个 spec 排两次结果一致（无随机性）', () => {
    expect(JSON.stringify(layoutDrawingSpec(flow))).toBe(JSON.stringify(layoutDrawingSpec(flow)));
  });
});