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
  const lastReasoningIndex = blocks.reduce(
    (last, block, index) => block.kind === 'reasoning' ? index : last,
    -1,
  );
  const hasAnswer = blocks.some((block) => block.kind === 'text');
  const lastIndex = blocks.length - 1;

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'reasoning') {
          return (
            <DomainReasoningRow
              key={`r-${index}`}
              text={block.text}
              running={streaming && index === lastReasoningIndex && !hasAnswer}
            />
          );
        }
        if (block.kind === 'tool-call') {
          return (
            <DomainToolRow
              key={block.callId}
              toolName={block.name}
              args={block.args}
              result={block.result}
              presentationMeta={block.presentationMeta}
              ok={block.ok}
              running={streaming && index === lastIndex}
            />
          );
        }
        return (
          <div key={`t-${index}`} className="bubble bubble--assistant">
            <AssistantMarkdown
              blocks={[{ kind: 'text', text: block.text }]}
              streaming={streaming && index === lastIndex}
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
