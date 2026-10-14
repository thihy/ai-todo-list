import { forwardRef } from 'react';
import { AttachmentPreview } from './AttachmentPreview';
import {
  Button,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconPlusOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';

/** Composer 附件元数据。文件本体留在磁盘（<rootDir>/.todo-list/
 *  dsh_workspace/inbox/c-<convId>-<ulid>-<basename>），AI 用 DSH `read` /
 *  `read_image` 工具流式读；prompt 里只塞 path 引用，不再 inline 全文。 */
export interface AIComposerAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

interface AIComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: readonly AIComposerAttachment[];
  onRemoveAttachment: (path: string) => void;
  onPickAttachment: () => void;
  onScreenshot?: () => void;
  screenshotBusy?: boolean;
  /** 剪贴板里带 `image/*` 时回调，文件已按剪贴板顺序排列。纯文本
   *  粘贴不触发 —— 那种情况不拦截，textarea 保持默认行为。 */
  onPasteFiles: (files: File[]) => void;
  onSubmit: () => void;
  onSteer?: () => void;
  enterAction?: 'queue' | 'steer';
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
    onScreenshot,
    screenshotBusy,
    onPasteFiles,
    onSubmit,
    onSteer,
    enterAction = 'queue',
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
                className={`aipane__attach-chip${attachment.mime.startsWith('image/') ? ' aipane__attach-chip--image' : ''}`}
                role="listitem"
                title={`${attachment.path}\n${attachment.mime} · ${attachment.size} 字节`}
              >
                <AttachmentPreview {...attachment} />
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
          onPaste={(event) => {
            // 只接管剪贴板里的图片项。截图在 Windows 上是 image/png，
            // macOS/Linux 截屏工具可能给 image/tiff —— 一律按 `image/`
            // 前缀收，扩展名由 AIPane 侧按 mime 推断。
            const items = event.clipboardData?.items;
            if (!items) return;
            const files: File[] = [];
            for (const it of items) {
              if (it.kind === 'file' && it.type.startsWith('image/')) {
                const file = it.getAsFile();
                if (file) files.push(file);
              }
            }
            if (files.length === 0) return;
            event.preventDefault();
            onPasteFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (blocked) return;
              const action = event.ctrlKey || event.metaKey ? (enterAction === 'queue' ? 'steer' : 'queue') : enterAction;
              if (busy && action === 'steer' && onSteer) onSteer();
              else onSubmit();
              return;
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault();
              onStop();
            }
          }}
          placeholder={block
            ? block.reason
            : busy
              ? (enterAction === 'queue' ? 'Enter 排队 · Ctrl+Enter 引导 · Esc 停止' : 'Enter 引导 · Ctrl+Enter 排队 · Esc 停止')
              : hasConversation
                ? '输入问题，回车发送…（Shift+Enter 换行，Esc 停止）'
                : '输入第一条问题，回车即创建对话…'}
          disabled={blocked}
          rows={1}
          className="aipane__input"
        />
        <div className="aipane__composer-actions">
          <div className="aipane__composer-tools">
          <Button
            variant="toolbar"
            type="button"
            className="aipane__attach-btn"
            onClick={onPickAttachment}
            disabled={blocked}
            title="选择文件"
            aria-label="选择文件"
          >
            <IconPlusOutline16 size={22} />
          </Button>
          {onScreenshot && <Button variant="toolbar" type="button" className="aipane__attach-btn"
            onClick={onScreenshot} disabled={blocked || screenshotBusy} title="截图（识别窗口或拖动框选）" aria-label="截图">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 8h4l2-3h4l2 3h4v12H4z" /><circle cx="12" cy="14" r="3.5" />
            </svg>
          </Button>}
          </div>
          {busy ? (
            <div className="aipane__send-actions">
              <Button variant="toolbar" type="button" onClick={onSubmit} disabled={blocked || (!value.trim() && attachments.length === 0)} aria-label="加入消息队列" title={enterAction === 'queue' ? '排队（Enter）' : '排队（Ctrl+Enter）'}>排队</Button>
              {onSteer && <Button variant="toolbar" type="button" onClick={onSteer} disabled={blocked || (!value.trim() && attachments.length === 0)} aria-label="引导当前任务" title={enterAction === 'steer' ? '引导（Enter）' : '引导（Ctrl+Enter）'}>引导</Button>}
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
            </div>
          ) : (
            <Button
              variant="primary"
              type="button"
              className="aipane__send"
              onClick={onSubmit}
              disabled={(!value.trim() && attachments.length === 0) || blocked}
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
