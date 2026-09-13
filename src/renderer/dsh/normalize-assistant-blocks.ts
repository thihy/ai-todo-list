// 归一化助手块——把内联 `<think>...</think>` 当成 reasoning 协议,其余正文保留。
//
// 设计要点(与"思考内容解析与展示"修复同步):
// - 纯函数:不修改入参数组或原始文本,允许多次重复调用得到稳定结果。
// - 状态扫描:不按字符正则,而是按字符流扫描,识别 `<think>` / `` / 行内 `code` / 围
//   栏 ```code```。
// - 工具块作为硬边界:tool-call 前后的 text 不允许跨块拼接,各自独立扫描。
// - 已有 reasoning、tool-call 块原样保留,只对 text 块做归一化。
// - 合并相邻同类输出块、移除空块;归一化幂等。
// - settled=false:暂存可能组成 `<think>` 的尾部残片(例如 `<thi`),避免流式短
//   暂闪现协议标签。
// - settled=true:无法凑齐完整标签的普通残片恢复为文本;`<think>` 已识别但 `` 缺
//   失时,已接收内容留在 reasoning 块,正文不补任何东西(不重复追加)。
// - 保守识别:`<think>` 必须出现在文本段开头 / 前导空白 / 段落起始后;代码块 / 行
//   内代码 / 引号里的 `<think>` 视作 prose,绝不参与协议识别。
//
// type-only 引入 AssistantTurnBlock,避免和 stream-turn.ts 出现运行时循环依赖。

import type { AssistantTurnBlock } from './stream-turn';

export interface NormalizeOptions {
  settled: boolean;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** 对外入口:对一组 assistant turn block 做归一化。 */
export function normalizeAssistantBlocks(
  blocks: readonly AssistantTurnBlock[],
  options: NormalizeOptions,
): AssistantTurnBlock[] {
  const emitted: AssistantTurnBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'reasoning') {
      appendOrMerge(emitted, { kind: 'reasoning', text: block.text });
      continue;
    }
    if (block.kind === 'tool-call') {
      emitted.push({
        kind: 'tool-call',
        callId: block.callId,
        name: block.name,
        args: block.args,
        result: block.result,
        presentationMeta: block.presentationMeta,
        ok: block.ok,
      });
      continue;
    }
    for (const out of scanText(block.text, options)) appendOrMerge(emitted, out);
  }
  return emitted;
}

function appendOrMerge(out: AssistantTurnBlock[], next: AssistantTurnBlock): void {
  if (next.kind === 'reasoning' && next.text === '') return;
  if (next.kind === 'text' && next.text === '') return;
  const tail = out[out.length - 1];
  // tool-call 块是硬边界——前后 text / reasoning 各自独立扫描、不允许跨块
  // 拼接。appendOrMerge 只合并同为 text 或同为 reasoning 的相邻块。
  if (next.kind === 'reasoning' && tail?.kind === 'reasoning') {
    tail.text = concatReasoning(tail.text, next.text);
    return;
  }
  if (next.kind === 'text' && tail?.kind === 'text') {
    tail.text = tail.text + next.text;
    return;
  }
  out.push(next);
}

function concatReasoning(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  if (a.endsWith('\n') || b.startsWith('\n')) return a + b;
  return a + '\n' + b;
}

// ---------- 状态扫描器 ----------
//
// 每个 text 块独立扫描一次;emit 用生成器 yield。注意:yield 只能在生成器
// 函数体内,不能放进内部箭头函数(esbuild 严格模式),所以下面直接展开。

function* scanText(input: string, options: NormalizeOptions): Generator<AssistantTurnBlock> {
  const len = input.length;
  let i = 0;
  let buf = '';
  let tagBuf = '';

  while (i < len) {
    const ch = input.charCodeAt(i);

    // --- 围栏代码块(行首或前导空白后):``` 或 ~~~ ---
    if (atLineStart(input, i)) {
      const fence = detectFenceOpen(input, i);
      if (fence !== null) {
        if (options.settled) buf += tagBuf;
        tagBuf = '';
        if (buf.length > 0) { yield { kind: 'text', text: buf }; buf = ''; }
        const after = consumeFence(input, i, fence);
        buf += input.slice(i, after);
        if (buf.length > 0) { yield { kind: 'text', text: buf }; buf = ''; }
        i = after;
        continue;
      }
    }

    // --- 行内 `code`:`、` ``、``` 等,直到等长闭合(GFM)。未闭合按 prose ---
    if (ch === 96 /* ` */) {
      const runLen = countRun(input, i, 96);
      if (runLen > 0) {
        const close = findInlineCodeClose(input, i, runLen);
        if (close !== -1) {
          if (options.settled) buf += tagBuf;
          tagBuf = '';
          buf += input.slice(i, close);
          if (buf.length > 0) { yield { kind: 'text', text: buf }; buf = ''; }
          i = close;
          continue;
        }
        // 未闭合 → 当 prose 走默认分支
      }
    }

    // --- 行内引号:`"` / `'` 配对,内部当 prose ---
    if (ch === 34 /* " */ || ch === 39 /* ' */) {
      if (options.settled) buf += tagBuf;
      tagBuf = '';
      buf += String.fromCharCode(ch);
      i++;
      while (i < len) {
        const c2 = input.charCodeAt(i);
        buf += String.fromCharCode(c2);
        i++;
        if (c2 === ch) break;
      }
      if (buf.length > 0) { yield { kind: 'text', text: buf }; buf = ''; }
      continue;
    }

    // --- `<think>` 起始 ---
    if (ch === 60 /* < */) {
      // 段中位置的 `<` 直接当 prose;不参与协议猜测。
      if (!atLineStart(input, i)) {
        if (options.settled) buf += tagBuf;
        tagBuf = '';
        buf += '<';
        i++;
        continue;
      }
      // 进入 tagBuf 累积。buf 暂存到 holdBuf——下面判定完 `<think>` 是
      // 完整识别 / 残片 / 中途失配后,再决定 holdBuf 是 trim、丢弃还是
      // 原样 emit。
      const holdBuf = buf;
      buf = '';
      tagBuf = '<';
      i++;
      // 边累积边判定:任意位置字符与 THINK_OPEN 不一致(大小写不敏感)→ 立刻
      // 退出 tagBuf,把这部分当 prose 写回 buf。否则继续吃字符,直到凑齐 7 个
      // 或到达输入末尾。
      while (i < len && tagBuf.length < THINK_OPEN.length) {
        const next = input[i];
        const want = THINK_OPEN[tagBuf.length];
        if (next !== want && next.toLowerCase() !== want) {
          // 不匹配 → 流式时直接丢弃 tagBuf,settled 时把累积的当 prose 写回
          // buf;无论哪种情况都不要再消费当前字符(交还给外层默认分支处理,
          // 避免把 `<thi` 泄漏到正文)。
          if (options.settled) buf += tagBuf;
          tagBuf = '';
          break;
        }
        tagBuf += next;
        i++;
      }
      if (tagBuf.length === THINK_OPEN.length) {
        // 完整识别 → 切到 InThink。holdBuf 末尾空白 trim 掉——这些空白是
        // `<think>` 之前的段落分隔,不写进 text 也不写进 reasoning。如果
        // 整段 holdBuf 都只是空白就完全丢弃,这样上游 reasoning 与本次
        // reasoning 仍能直接 merge。
        tagBuf = '';
        const trimmed = holdBuf.replace(/\s+$/, '');
        if (trimmed.length > 0) { yield { kind: 'text', text: trimmed }; }
        const scan = awaitInThink(input, i);
        if (scan.text.length > 0) yield { kind: 'reasoning', text: scan.text };
        i = scan.endPos;
        continue;
      }
      if (tagBuf.length > 0) {
        // 残片:循环跑到末尾仍未凑齐。流式时 holdBuf + tagBuf 一起丢弃,
        // settled 时把它们当 prose 一起 emit。
        if (options.settled) {
          const restored = holdBuf + tagBuf;
          if (restored.length > 0) { yield { kind: 'text', text: restored }; }
        }
        tagBuf = '';
        continue;
      }
      // tagBuf 已被 mismatch 清空 → holdBuf 原样 emit 为 prose,tagBuf
      // 已经丢弃,默认分支会继续处理当前字符。
      if (holdBuf.length > 0) { yield { kind: 'text', text: holdBuf }; }
      continue;
    }

    // --- 普通字符 ---
    if (tagBuf.length > 0) {
      // 上一轮 tagBuf 没凑齐时已被处理,这里只清空标记,字符直接写入 buf。
      tagBuf = '';
    }
    buf += String.fromCharCode(ch);
    i++;
  }

  // 收尾。
  if (options.settled && tagBuf.length > 0) buf += tagBuf;
  if (buf.length > 0) yield { kind: 'text', text: buf };
}

// ---------- helpers ----------

function atLineStart(input: string, i: number): boolean {
  // 向前看,跳过 trailing whitespace(空格 / Tab)后,只要前面是 \n / \r 或输入起
  // 点,就视作"行首 / 前导空白后"——`<think>` 协议可在此猜测。
  let k = i - 1;
  while (k >= 0 && (input[k] === ' ' || input[k] === '\t')) k--;
  if (k < 0) return true;
  return input[k] === '\n' || input[k] === '\r';
}

function countRun(input: string, i: number, charCode: number): number {
  const len = input.length;
  let n = 0;
  while (i + n < len && input.charCodeAt(i + n) === charCode) n++;
  return n;
}

/** 行内代码:从 i(已确定 ` 起点)开始,跳过开 run,找等长闭合(GFM)。失败 -1 */
function findInlineCodeClose(input: string, i: number, runLen: number): number {
  const len = input.length;
  let j = i + runLen;
  while (j < len) {
    if (input.charCodeAt(j) === 96) {
      let closeLen = 0;
      while (j + closeLen < len && input.charCodeAt(j + closeLen) === 96) closeLen++;
      if (closeLen >= runLen) return j + closeLen;
      j += closeLen;
      continue;
    }
    j++;
  }
  return -1;
}

function detectFenceOpen(input: string, i: number): { ch: number; len: number } | null {
  const ch = input.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  const count = countRun(input, i, ch);
  if (count < 3) return null;
  return { ch, len: count };
}

/** 整段围栏代码(包含开 fence / info string / 内容 / 闭 fence)emit 为 text。 */
function consumeFence(input: string, i: number, fence: { ch: number; len: number }): number {
  const len = input.length;
  let j = i + fence.len;
  while (j < len && input[j] !== '\n') j++;
  if (j < len) j++;
  while (j < len) {
    if (input.charCodeAt(j) === fence.ch) {
      const count = countRun(input, j, fence.ch);
      if (count >= fence.len) {
        j += count;
        while (j < len && (input[j] === ' ' || input[j] === '\t')) j++;
        if (j < len && input[j] === '\n') j++;
        return j;
      }
      j += count;
      continue;
    }
    j++;
  }
  return j;
}

function awaitInThink(input: string, i: number): { endPos: number; text: string } {
  const len = input.length;
  let acc = '';
  while (i < len) {
    const idx = input.toLowerCase().indexOf(THINK_CLOSE, i);
    if (idx === -1) {
      acc += input.slice(i);
      i = len;
      break;
    }
    acc += input.slice(i, idx);
    i = idx + THINK_CLOSE.length;
    break;
  }
  return { endPos: i, text: acc };
}