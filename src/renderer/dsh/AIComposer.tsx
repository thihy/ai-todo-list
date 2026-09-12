import { forwardRef } from 'react';
import {
  Button,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconPlusOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';

export interface AIComposerAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
  text: string;
}

interface AIComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: readonly AIComposerAttachment[];
  onRemoveAttachment: (path: string) => void;
  onPickAttachment: () => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  hasConversation: boolean;
  block?: ComposerBlock;
}

/** Electron host adapter for the DSH composer surface.
 *
 * DSH 0.1.5's full InputBar is installed through its browser module loader
 * and service/slot graph, so it cannot be imported as a standalone React
 * component here. This seam uses its public primitives and ComposerBlock
 * contract while keeping native file picking and IPC submission host-owned.
 */
export const AIComposer = forwardRef<HTMLTextAreaElement, AIComposerProps>(function AIComposer(
  {
    value,
    onChange,
    attachments,
    onRemoveAttachment,
    onPickAttachment,
    onSubmit,
    onStop,
    busy,
    hasConversation,
    block,
  },
  ref,
) {
  const blocked = block !== undefined;
  return (
    <div className="aipane__composer">
      <div className={`aipane__composer-card${blocked ? ' is-disabled' : ''}`}>
        {attachments.length > 0 && (
          <div className="aipane__attach-row" role="list" aria-label="已附加的文件">
            {attachments.map((attachment) => (
              <span
                key={attachment.path}
                className="aipane__attach-chip"
                role="listitem"
                title={`${attachment.path}\n${attachment.mime} · ${attachment.size} 字节`}
              >
                <span className="aipane__attach-chip-icon" aria-hidden="true">
                  <IconPaperclipOutline16 size={11} />
                </span>
                <span className="aipane__attach-chip-name">{attachment.name}</span>
                <Button
                  variant="toolbar"
                  size="sm"
                  className="aipane__attach-chip-x"
                  onClick={() => onRemoveAttachment(attachment.path)}
                  disabled={blocked}
                  aria-label={`移除 ${attachment.name}`}
                  title="移除"
                >
                  <IconCloseOutline16 size={10} />
                </Button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          aria-label="向 AI 提问"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
              return;
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault();
              onStop();
            }
          }}
          placeholder={block
            ? block.reason
            : hasConversation
              ? '输入问题，回车发送…（Shift+Enter 换行，Esc 停止）'
              : '输入第一条问题，回车即创建对话…'}
          disabled={blocked}
          rows={1}
          className="aipane__input"
        />
        <div className="aipane__composer-actions">
          <Button
            variant="toolbar"
            type="button"
            className="aipane__attach-btn"
            onClick={onPickAttachment}
            disabled={blocked}
            title="选择文件"
            aria-label="选择文件"
          >
            <IconPlusOutline16 size={18} />
          </Button>
          {busy ? (
            <Button
              variant="primary"
              type="button"
              className="aipane__stop"
              onClick={onStop}
              title="停止生成（Esc）"
              aria-label="停止生成"
            >
              <IconStopFill16 size={14} />
            </Button>
          ) : (
            <Button
              variant="primary"
              type="button"
              className="aipane__send"
              onClick={onSubmit}
              disabled={!value.trim() || blocked}
              title={hasConversation ? '发送（Enter）' : '发送并创建对话'}
              aria-label="发送"
            >
              <IconSendOutline16 size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
