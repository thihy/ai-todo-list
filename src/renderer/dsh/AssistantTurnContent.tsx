import React from 'react';
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { AssistantTurnBlock } from './stream-turn';
import { DomainReasoningRow } from './DomainReasoningRow';
import { DomainToolRow } from './DomainToolRow';
import { AssistantMarkdown } from './ui-chat/chat/AssistantMarkdown';
import { conversationT } from './conversation-locale';

/** DSH-backed rendering boundary for the ordered assistant portion of a turn. */
export const AssistantTurnContent: React.FC<{
  blocks: AssistantTurnBlock[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
}> = ({ blocks, status, error }) => {
  const streaming = status === 'streaming';

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'reasoning') {
          // Reasoning rows have their own running indicator; we just pass
          // through here.
          return (
            <DomainReasoningRow
              key={`r-${index}`}
              text={block.text}
              running={streaming}
            />
          );
        }
        if (block.kind === 'tool-call') {
          // The block's `state` is the AUTHORITATIVE source for "is this
          // tool still running?" — set explicitly by projectStreamTurn
          // when tool/call arrives (running) and tool/result arrives
          // (done/error/stopped/missing-*). NEVER infer from
          // "is this the last block in a streaming turn" — that's wrong
          // for multi-tool turns and for missing-result cases.
          const toolRunning = block.state === 'running';
          return (
            <DomainToolRow
              key={block.callId}
              toolName={block.name}
              args={block.args}
              argsKnown={block.argsKnown}
              result={block.result}
              resultKnown={block.resultKnown}
              presentationMeta={block.presentationMeta}
              ok={block.ok}
              state={block.state}
              running={toolRunning}
            />
          );
        }
        // 文本块空 / 纯空白时不渲染 .bubble——否则会留下一块带 padding /
        // border 的空方块（"空白小块"）。流式中也跳：流式阶段的"思考中…"
        // 提示由下方的 blocks.length === 0 分支承担，不重复占位。
        if (block.text.trim() === '') return null;
        return (
          <div key={`t-${index}`} className="bubble bubble--assistant">
            <AssistantMarkdown
              blocks={[{ kind: 'text', text: block.text }]}
              streaming={streaming}
              renderMessageImages={() => null}
              t={conversationT}
            />
          </div>
        );
      })}
      {streaming && blocks.length === 0 && (
        <div className="aipane__thinking" role="status">
          <span className="aipane__dot" aria-hidden="true" />思考中…
        </div>
      )}
      {status === 'error' && (
        <div className="bubble bubble--error" role="alert">
          <IconWarningOutline16 size={14} /> {error}
        </div>
      )}
    </>
  );
};
