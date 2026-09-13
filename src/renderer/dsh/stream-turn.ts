import type { AIStreamEvent } from '../../shared/ai-types';
import { normalizeAssistantBlocks } from './normalize-assistant-blocks';

export type AssistantTurnBlock =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; callId: string; name: string; args: unknown; result: unknown; presentationMeta?: unknown; ok: boolean }
  | { kind: 'text'; text: string };

export interface StreamTurnProjection {
  blocks: AssistantTurnBlock[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
  firstTokenTs?: number;
  endTs?: number;
  tokensOut?: number;
  createdTodoId: string | null;
}

/** Convert one invocation's renderer stream into a deterministic turn view. */
export function projectStreamTurn(
  events: readonly AIStreamEvent[],
  invocationId: string,
): StreamTurnProjection | null {
  const mine = events.filter((event) => event.invocationId === invocationId);
  if (mine.length === 0) return null;

  const blocks: AssistantTurnBlock[] = [];
  let toolSeq = 0;
  let createdTodoId: string | null = null;
  let firstTokenTs: number | undefined;

  for (const event of mine) {
    if (event.type === 'reasoning') {
      if (!event.text) continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'reasoning') last.text += event.text;
      else blocks.push({ kind: 'reasoning', text: event.text });
      continue;
    }
    if (event.type === 'token') {
      if (!event.token) continue;
      if (firstTokenTs === undefined && event.ts !== undefined) firstTokenTs = event.ts;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') last.text += event.token;
      else blocks.push({ kind: 'text', text: event.token });
      continue;
    }
    if (event.type !== 'toolCall') continue;
    blocks.push({
      kind: 'tool-call',
      callId: `tool-${toolSeq++}`,
      name: event.toolName,
      args: event.args,
      result: event.result,
      presentationMeta: event.presentationMeta,
      ok: event.ok,
    });
    if (
      createdTodoId === null &&
      event.ok &&
      event.toolName === 'todo.create' &&
      typeof event.result === 'object' &&
      event.result !== null
    ) {
      const id = (event.result as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) createdTodoId = id;
    }
  }

  // 用原始 token / reasoning 判断是否已经收到任何助手内容。done.content 兜底只
  // 用于"流式聚合空"的情况(非流式 / adapter 没有回放 token),且仅追加一次;之
  // 后会与归一化一起走,避免与归一化后是否还剩 text 之间的耦合——纯思考响应在
  // 结束时如果按"归一化后是否还有 text"判定,就会被错误地再追加一次 content。
  const hasAnyAssistantContent = blocks.some(
    (block) => block.kind === 'text' || block.kind === 'reasoning',
  );
  const doneEvent = mine.find((event): event is Extract<AIStreamEvent, { type: 'done' }> => event.type === 'done');
  if (doneEvent?.content && !hasAnyAssistantContent) {
    blocks.push({ kind: 'text', text: doneEvent.content });
  }
  const errorEvent = mine.find((event): event is Extract<AIStreamEvent, { type: 'error' }> => event.type === 'error');

  // 归一化:在所有块聚合完成后、含 done.content 兜底,统一识别 `<think>...</think>`。
  const settled = Boolean(doneEvent || errorEvent);
  const normalizedBlocks = normalizeAssistantBlocks(blocks, { settled });

  return {
    blocks: normalizedBlocks,
    status: errorEvent ? 'error' : doneEvent ? 'done' : 'streaming',
    ...(errorEvent ? { error: errorEvent.message } : {}),
    ...(firstTokenTs === undefined ? {} : { firstTokenTs }),
    ...(doneEvent?.ts === undefined ? {} : { endTs: doneEvent.ts }),
    ...(doneEvent?.tokensOut === undefined ? {} : { tokensOut: doneEvent.tokensOut }),
    createdTodoId,
  };
}
