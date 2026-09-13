import { describe, expect, it } from 'vitest';
import {
  normalizeAssistantBlocks,
} from '../../src/renderer/dsh/normalize-assistant-blocks';
import type { AssistantTurnBlock } from '../../src/renderer/dsh/stream-turn';

const text = (s: string): AssistantTurnBlock => ({ kind: 'text', text: s });
const reason = (s: string): AssistantTurnBlock => ({ kind: 'reasoning', text: s });

const kinds = (blocks: AssistantTurnBlock[]): string[] =>
  blocks.map((b) => `${b.kind}:${b.kind === 'text' || b.kind === 'reasoning' ? b.text : (b as { name: string }).name}`);

describe('normalizeAssistantBlocks — core', () => {
  it('把 `<think>分析</think>最终回答` 拆成 reasoning + text', () => {
    const out = normalizeAssistantBlocks([text('<think>分析</think>最终回答')], { settled: true });
    expect(kinds(out)).toEqual(['reasoning:分析', 'text:最终回答']);
  });

  it('大小写不敏感:`<THINK>分析</THINK>` 同样识别', () => {
    const out = normalizeAssistantBlocks([text('<THINK>分析</THINK>回答')], { settled: true });
    expect(kinds(out)).toEqual(['reasoning:分析', 'text:回答']);
  });

  it('行首 `<think>` 紧跟一段正文,正文保留', () => {
    const out = normalizeAssistantBlocks([text('<think>分析</think>')], { settled: true });
    expect(kinds(out)).toEqual(['reasoning:分析']);
  });

  it('段中位置的 `<think>` 视作 prose(只识别行首 / 前导空白后)', () => {
    const out = normalizeAssistantBlocks([text('前缀<think>不是协议</think>回答')], { settled: true });
    expect(kinds(out)).toEqual(['text:前缀<think>不是协议</think>回答']);
  });

  it('行首(前导空白后)的 `<thi` 流式暂存不闪现,但前面的正文已独立 emit', () => {
    // 故意在前一行留 \n,确保 atLineStart 命中——`<` 协议猜测走起,前面的明文
    // "前缀\n" 已独立 emit;`<thi` 流式被丢弃,后续"继续"重新走 buf。
    const out = normalizeAssistantBlocks([text('前缀\n<thi继续')], { settled: false });
    const joined = out
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(joined).toContain('前缀\n');
    expect(joined).not.toContain('<thi');
    // "继续" 不应丢
    expect(joined).toContain('继续');
  });

  it('流式:`<think>` 已识别但 `` 尚未到来时,内容不进正文', () => {
    const out = normalizeAssistantBlocks([text('<think>还没结束')], { settled: false });
    expect(kinds(out)).toEqual(['reasoning:还没结束']);
  });

  it('settled + 缺失 ``:已接收内容留在 reasoning,正文不补任何东西', () => {
    const out = normalizeAssistantBlocks([text('<think>还没结束')], { settled: true });
    expect(kinds(out)).toEqual(['reasoning:还没结束']);
  });

  it('行内代码里的 `<think>` 视作 prose', () => {
    const out = normalizeAssistantBlocks([text('示意 `<think>` 标签')], { settled: true });
    expect(kinds(out)).toEqual(['text:示意 `<think>` 标签']);
  });

  it('围栏代码块里的 `<think>` 视作 prose', () => {
    const src = '示例:\n```\n假装内容\n```\n结束';
    const out = normalizeAssistantBlocks([text(src)], { settled: true });
    expect(kinds(out)).toEqual([`text:${src}`]);
  });

  it('重复归一化结果应相同(幂等)', () => {
    const blocks = [
      text('<think>x</think>继续'),
      reason('已有'),
      text('<think>y</think>z'),
    ];
    const a = normalizeAssistantBlocks(blocks, { settled: true });
    const b = normalizeAssistantBlocks(a, { settled: true });
    expect(b).toEqual(a);
  });

  it('已有 reasoning + 后接 `<think>` 文本:不重复 reasoning', () => {
    const out = normalizeAssistantBlocks(
      [reason('原思考'), text('<think>内联思考</think>正文')],
      { settled: true },
    );
    expect(kinds(out)).toEqual([
      'reasoning:原思考\n内联思考',
      'text:正文',
    ]);
  });

  it('混合原生 reasoning 事件 + 字面 `<think>` 协议:都能归位', () => {
    const out = normalizeAssistantBlocks(
      [reason('原生思考'), text('<think>协议思考</think>最终正文')],
      { settled: true },
    );
    expect(kinds(out)).toEqual([
      'reasoning:原生思考\n协议思考',
      'text:最终正文',
    ]);
  });

  it('保留 reasoning 与 text 的相对顺序;tool-call 始终原样穿过', () => {
    // 行首(前导 \t)让 `<think>` 在每段开头都被识别,工具块前后的 text 各自独立扫描。
    const out = normalizeAssistantBlocks(
      [
        text('前言\n<think>分析</think>结论'),
        reason('已有'),
        text('\n<think>后续思考</think>收尾'),
      ],
      { settled: true },
    );
    // reasoning + reasoning 走 appendOrMerge 合并(连换行分隔)——同块内的协议化
    // 思考与原本的 reasoning 合并,这是想要的行为(避免拆分同一思考)。
    expect(kinds(out)).toEqual([
      'text:前言',
      'reasoning:分析',
      'text:结论',
      'reasoning:已有\n后续思考',
      'text:收尾',
    ]);
  });

  it('settled=true + 普通 prose + 半截 `<` 不会丢正文', () => {
    // 文档中间一个孤立的 `<`,settled 时降级 prose。
    const settled = normalizeAssistantBlocks([text('价格 < 100')], { settled: true });
    expect(kinds(settled)).toEqual(['text:价格 < 100']);
  });
});