// Streaming-turn projection — pure function over the raw `ai:stream` event
// array, scoped to one invocationId. Decides the order of reasoning ↔ tool-
// call ↔ text blocks AND pairs `tool/call` with `tool/result` against the
// real callId from the wire.
//
// Why this lives in a pure function (and not the React useState updater):
// `useTodoListApi.ts`'s setEvents updater can be invoked twice in StrictMode
// (development double-render). Any side-effect map mutation there would be
// lost or duplicated — breaking call/result pairing. Walking the events
// array here is idempotent: re-projecting yields the same blocks.
//
// Block layout contract:
//   - Tools are ordered by the position of the FIRST event (call OR result)
//     for their callId. A tool/result that arrives before its tool/call is
//     buffered until the call shows up, at which point the block is created
//     at the call's position with whatever state has accumulated.
//   - Same tool called multiple times → different callIds → distinct blocks.
//   - The block's state field carries the explicit lifecycle, NOT a guess
//     from "is this the last block in a streaming turn?".

import type { AIStreamEvent } from '../../shared/ai-types';
import { recoverToolResultValue, parseToolArgs } from '../tool-presentation';
import { normalizeAssistantBlocks } from './normalize-assistant-blocks';

/** Explicit tool-call lifecycle. */
export type ToolCallState =
  /** tool/call seen, no tool/result yet. */
  | 'running'
  /** tool/result seen with `ok=true`. */
  | 'done'
  /** tool/result seen with `ok=false` (failure). */
  | 'error'
  /** tool/result seen with `cancelled:` prefix (user-cancelled). */
  | 'stopped'
  /** Only tool/result seen (no tool/call arrived). */
  | 'missing-call'
  /** Only tool/call seen (turn ended before result). */
  | 'missing-result';

export type AssistantTurnBlock =
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool-call';
      /** DSH tool-call id from the wire. Stable across re-renders →
          React key + dedupe key when the same tool is called twice. */
      callId: string;
      /** Tool name. `''` when argsKnown === false. */
      name: string;
      /** Parsed args object (or string when not valid JSON). */
      args: unknown;
      /** False when no tool/call event arrived. Distinguishes "{} no params"
          from "missing-call: 未记录输入". */
      argsKnown: boolean;
      /** Tool result; only meaningful when resultKnown === true. */
      result: unknown;
      /** False when no tool/result event arrived. */
      resultKnown: boolean;
      /** DSH tool-owned presentation payload from tool/result.meta. */
      presentationMeta?: unknown;
      /** Convenience flag — same as `state === 'done'`. Kept for callers
          that haven't migrated to the new state field. */
      ok: boolean;
      /** Explicit lifecycle. Replaces the old "is last block?" heuristic. */
      state: ToolCallState;
    }
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

interface ToolEntry {
  name: string;
  args: unknown;
  argsKnown: boolean;
  result: unknown;
  resultKnown: boolean;
  presentationMeta?: unknown;
  ok: boolean;
  state: ToolCallState;
}

function newToolEntry(): ToolEntry {
  return {
    name: '',
    args: undefined,
    argsKnown: false,
    result: undefined,
    resultKnown: false,
    ok: false,
    state: 'missing-result',
  };
}

/** Convert one invocation's renderer stream into a deterministic turn view. */
export function projectStreamTurn(
  events: readonly AIStreamEvent[],
  invocationId: string,
): StreamTurnProjection | null {
  const mine = events.filter((event) => event.invocationId === invocationId);
  if (mine.length === 0) return null;

  const blocks: AssistantTurnBlock[] = [];
  // Per-callId bookkeeping. Both maps are local to this invocation; nothing
  // leaks between invocations or across renders (the function is pure).
  const toolEntryByCallId = new Map<string, ToolEntry>();
  const toolBlockIndexByCallId = new Map<string, number>();
  let orphanCounter = 0;

  let createdTodoId: string | null = null;
  let firstTokenTs: number | undefined;
  let bufText = '';
  let bufReasoning = '';

  const flushAssistant = (): void => {
    if (bufReasoning) {
      blocks.push({ kind: 'reasoning', text: bufReasoning });
      bufReasoning = '';
    }
    if (bufText) {
      blocks.push({ kind: 'text', text: bufText });
      bufText = '';
    }
  };

  const entryToBlock = (callId: string, entry: ToolEntry): AssistantTurnBlock => ({
    kind: 'tool-call',
    callId,
    name: entry.name,
    args: entry.args,
    argsKnown: entry.argsKnown,
    result: entry.result,
    resultKnown: entry.resultKnown,
    presentationMeta: entry.presentationMeta,
    ok: entry.ok,
    state: entry.state,
  });

  const handleToolCall = (d: {
    callId?: unknown;
    name?: string;
    arguments?: string;
  } | undefined): void => {
    if (!d) return;
    const callId = d.callId != null ? String(d.callId) : '';
    if (!callId) return;
    let entry = toolEntryByCallId.get(callId);
    if (!entry) {
      entry = newToolEntry();
      toolEntryByCallId.set(callId, entry);
    }
    entry.name = typeof d.name === 'string' ? d.name : '';
    entry.args = parseToolArgs(d.arguments);
    // argsKnown only when we actually saw a non-empty name. An empty string
    // would be a degenerate tool call we don't want to pretend was valid.
    entry.argsKnown = entry.name.length > 0;
    if (!entry.resultKnown) entry.state = 'running';
    const idx = toolBlockIndexByCallId.get(callId);
    if (idx === undefined) {
      flushAssistant();
      blocks.push(entryToBlock(callId, entry));
      toolBlockIndexByCallId.set(callId, blocks.length - 1);
    } else {
      blocks[idx] = entryToBlock(callId, entry);
    }
  };

  const handleToolResult = (d: {
    message?: {
      source?: { callId?: unknown };
      content?: Array<{ isError?: boolean; content?: unknown[] }>;
    };
    meta?: unknown;
  } | undefined): void => {
    if (!d) return;
    const rawCallId = d.message?.source?.callId;
    const callId = rawCallId != null ? String(rawCallId) : '';
    const block = d.message?.content?.[0];
    const ok = !block?.isError;
    const result = recoverToolResultValue(block?.content);
    const presentationMeta = d.meta;
    // DSH uses 'cancelled:' prefix to mark user-stopped runs (main injects
    // this from the cancel path). Mirror DomainToolRow's detection so the
    // projection's state agrees with what the renderer would compute.
    const stopped = ok === false && typeof result === 'string' && result.startsWith('cancelled:');
    const state: ToolCallState = stopped ? 'stopped' : ok ? 'done' : 'error';

    if (!callId) {
      // Orphan result — never had a matching call. Render a placeholder at
      // arrival position so the user still sees the outcome. A synthesised
      // "orphan-N" callId keeps it distinct from any real callId and from
      // other orphans (rare but possible in pathological streams).
      flushAssistant();
      const orphanCallId = `orphan-${orphanCounter++}`;
      const entry = newToolEntry();
      entry.result = result;
      entry.resultKnown = true;
      entry.presentationMeta = presentationMeta;
      entry.ok = ok;
      entry.state = 'missing-call';
      toolEntryByCallId.set(orphanCallId, entry);
      blocks.push(entryToBlock(orphanCallId, entry));
      toolBlockIndexByCallId.set(orphanCallId, blocks.length - 1);
      return;
    }

    let entry = toolEntryByCallId.get(callId);
    if (!entry) {
      entry = newToolEntry();
      toolEntryByCallId.set(callId, entry);
    }
    entry.result = result;
    entry.resultKnown = true;
    entry.presentationMeta = presentationMeta;
    entry.ok = ok;
    entry.state = state;

    const idx = toolBlockIndexByCallId.get(callId);
    if (idx === undefined) {
      // Result arrived before its tool/call. Buffer at the result's
      // position so the user sees the outcome immediately; the matching
      // tool/call will update name+args+state in place when it arrives.
      flushAssistant();
      blocks.push(entryToBlock(callId, entry));
      toolBlockIndexByCallId.set(callId, blocks.length - 1);
    } else {
      blocks[idx] = entryToBlock(callId, entry);
    }

    // Harvest createdTodoId — used by AIPane to open the created todo's
    // detail panel on turn completion. Only the FIRST successful
    // todo_create per turn counts.
    if (
      createdTodoId === null &&
      ok &&
      entry.name === 'todo_create' &&
      typeof result === 'object' &&
      result !== null
    ) {
      const id = (result as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) createdTodoId = id;
    }
  };

  for (const event of mine) {
    if (event.type === 'reasoning') {
      if (!event.text) continue;
      bufReasoning += event.text;
      continue;
    }
    if (event.type === 'token') {
      if (!event.token) continue;
      if (firstTokenTs === undefined && event.ts !== undefined) firstTokenTs = event.ts;
      bufText += event.token;
      continue;
    }
    if (event.type === 'sessionEvent') {
      const raw = event.event;
      const t = raw?.type;
      if (t === 'tool/call') {
        handleToolCall(raw.data as { callId?: unknown; name?: string; arguments?: string } | undefined);
        continue;
      }
      if (t === 'tool/result') {
        handleToolResult(raw.data as {
          message?: {
            source?: { callId?: unknown };
            content?: Array<{ isError?: boolean; content?: unknown[] }>;
          };
          meta?: unknown;
        } | undefined);
        continue;
      }
      // Other sessionEvent types (assistant/chunk handled above as token /
      // reasoning; assistant/message handled below in the done.content
      // fallback; structural events / step boundaries / request/*) are
      // intentionally not consumed here — see foldHistory for the full
      // history-projection version.
      continue;
    }
  }

  // done.content fallback — only fires when streaming aggregation was empty
  // (non-streaming run / adapter that didn't emit token deltas). Single
  // append, AFTER the turn walk, to avoid double-counting text that flowed
  // through `token` events above.
  const hasAnyAssistantContent =
    blocks.some((block) => block.kind === 'text' || block.kind === 'reasoning') ||
    bufText.length > 0 ||
    bufReasoning.length > 0;
  const doneEvent = mine.find(
    (event): event is Extract<AIStreamEvent, { type: 'done' }> => event.type === 'done',
  );
  if (doneEvent?.content && !hasAnyAssistantContent) {
    bufText += doneEvent.content;
  }
  const errorEvent = mine.find(
    (event): event is Extract<AIStreamEvent, { type: 'error' }> => event.type === 'error',
  );

  flushAssistant();

  // Pending tool calls that never received a result should not stay
  // "running" forever once the turn has settled — flip them to
  // missing-result so the UI doesn't keep the spinner pulsing.
  if (doneEvent || errorEvent) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.kind === 'tool-call' && block.state === 'running') {
        blocks[i] = { ...block, state: 'missing-result' };
      }
    }
  }

  // Normalise: detect inline <think>...</think> in text blocks, etc.
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