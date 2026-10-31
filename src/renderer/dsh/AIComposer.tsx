import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import type { AssistantCommand, SkillItem } from '../../shared/assistant-capabilities';
import '../components/assistant-capabilities.css';
import './ai-composer.css';
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

function SkillMenuIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4H5a1 1 0 0 0-1 1v4a3 3 0 1 1 0 6v4a1 1 0 0 0 1 1h4a3 3 0 1 1 6 0h4a1 1 0 0 0 1-1v-4a3 3 0 1 0 0-6V5a1 1 0 0 0-1-1h-4a3 3 0 1 0-6 0Z" /></svg>;
}

function AutomationMenuIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 2h6M18 5l2-2" /></svg>;
}

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
  permissionControl?: React.ReactNode;
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
    permissionControl,
  },
  ref,
) {
  const blocked = block !== undefined;
  const [sendAction, setSendAction] = useState(enterAction);
  useEffect(() => setSendAction(enterAction), [enterAction]);
  const menuId = useId();
  const [commands, setCommands] = useState<AssistantCommand[]>([]);
  const [commandError, setCommandError] = useState('');
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState('');
  const addMenu = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const addMenuId = useId();
  const closeAdd = (restoreFocus = false) => { setShowAddMenu(false); if (restoreFocus) addButton.current?.focus(); };
  const openPanel = (panel: 'skills' | 'automations') => { closeAdd(); window.dispatchEvent(new CustomEvent('assistant:capability', { detail: panel })); };
  useEffect(() => {
    if (!showAddMenu) return;
    if (blocked) { setShowAddMenu(false); return; }
    let cancelled = false;
    const first = requestAnimationFrame(() => addMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    const outside = (event: PointerEvent) => { if (!addMenu.current?.contains(event.target as Node) && !addButton.current?.contains(event.target as Node)) setShowAddMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setShowAddMenu(false); addButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    setSkillsLoading(true); setSkillsError('');
    if (window.todoList.skill?.list) {
      void window.todoList.skill.list().then((result) => { if (cancelled) return; if (result.ok) setSkills(result.data.filter((item) => item.userInvocable)); else setSkillsError(result.message); }).catch((error) => { if (!cancelled) setSkillsError(String(error)); }).finally(() => { if (!cancelled) setSkillsLoading(false); });
    } else setSkillsLoading(false);
    return () => { cancelled = true; cancelAnimationFrame(first); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [showAddMenu, blocked]);
  const commandQuery = /^\/[a-z-]*$/.test(value);
  useEffect(() => {
    if (!commandQuery) return;
    let cancelled = false;
    setCommandError('');
    void window.todoList.skill.commands().then((result) => {
      if (cancelled) return;
      if (result.ok) setCommands(result.data); else setCommandError(result.message);
    }).catch((error) => { if (!cancelled) setCommandError(String(error)); });
    return () => { cancelled = true; };
  }, [commandQuery]);
  const filtered = commands.filter((command) => command.name.startsWith(value.slice(1)));
  const showCommands = commandQuery && !dismissed;
  const pick = (command: AssistantCommand) => { onChange(`/${command.name}${command.hint ? ' ' : ''}`); setDismissed(true); setSelected(0); };
  return (
    <div className="aipane__composer">
      {showAddMenu && <div ref={addMenu} id={addMenuId} className="composer-add-menu" role="menu" aria-label="添加到对话" onKeyDown={(event) => {
        const buttons = [...(addMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) {
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus(); buttons[index]?.scrollIntoView({ block: 'nearest' });
        }
        if (event.key === 'Tab') setShowAddMenu(false);
      }}>
        <div className="composer-add-menu__group">添加</div>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { closeAdd(); onPickAttachment(); }}><IconPaperclipOutline16 size={16} /><strong>添加文件</strong><span>选择本地文件附加到对话</span></button>
        {onScreenshot && <button type="button" role="menuitem" tabIndex={-1} disabled={screenshotBusy} onClick={() => { closeAdd(); onScreenshot(); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 8h4l2-3h4l2 3h4v12H4z" /><circle cx="12" cy="14" r="3.5" /></svg><strong>截图</strong><span>识别窗口或拖动框选</span></button>}
        <div className="composer-add-menu__group">助手</div>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => openPanel('automations')}><AutomationMenuIcon /><strong>自动化</strong><span>查看和管理周期任务</span></button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => openPanel('skills')}><SkillMenuIcon /><strong>技能清单</strong><span>浏览、安装和使用本地技能</span></button>
        {!!skills.length && <div className="composer-add-menu__group">可用技能</div>}
        {skills.slice(0, 8).map((skill) => <button key={skill.name} type="button" role="menuitem" tabIndex={-1} onClick={() => { closeAdd(); onChange('请使用 ' + skill.name + ' 技能' + (value.trim() ? '：\n' + value : '，')); requestAnimationFrame(() => { const input = typeof ref === 'object' ? ref?.current : null; input?.focus(); }); }}><SkillMenuIcon /><strong>{skill.name}</strong><span>{skill.description}</span></button>)}
        {skillsLoading && <p role="status">正在读取本地技能…</p>}
        {skillsError && <p role="status">{skillsError}</p>}
      </div>}
      {showCommands && <div id={menuId} className="assistant-command-menu" role="listbox" aria-label="系统命令">
        <div className="assistant-command-menu__head">系统命令<span>↑ ↓ 选择 · Tab / Enter 填入 · Esc 关闭</span></div>
        {commandError ? <p role="status">{commandError}</p> : filtered.length === 0 ? <p>{commands.length ? '没有匹配的命令' : '正在读取命令…'}</p> : filtered.map((command, index) => <button id={`${menuId}-${index}`} type="button" role="option" aria-selected={index === selected} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(command)}><strong>/{command.name}</strong><span>{command.description}</span></button>)}
      </div>}
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
          aria-controls={showCommands ? menuId : undefined}
          aria-activedescendant={showCommands && filtered[selected] ? `${menuId}-${selected}` : undefined}
          value={value}
          onChange={(event) => { setSelected(0); setDismissed(false); onChange(event.target.value); }}
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
            if (showCommands) {
              if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) { event.preventDefault(); setSelected((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length); return; }
              if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey && filtered[selected]) { event.preventDefault(); pick(filtered[selected]); return; }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (blocked) return;
              const action = event.ctrlKey || event.metaKey ? (sendAction === 'queue' ? 'steer' : 'queue') : sendAction;
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
              ? (sendAction === 'queue' ? 'Enter 排队 · Ctrl+Enter 引导 · Esc 停止' : 'Enter 引导 · Ctrl+Enter 排队 · Esc 停止')
              : hasConversation
                ? '输入消息，或输入 / 查看命令'
                : '和 AI 助手一起工作'}
          disabled={blocked}
          rows={1}
          className="aipane__input"
        />
        <div className="aipane__composer-actions">
          <div className="aipane__composer-tools">
          <button
            type="button"
            className="aipane__attach-btn"
            ref={addButton}
            onClick={() => { setDismissed(true); setShowAddMenu((open) => !open); }}
            disabled={blocked}
            title="添加文件、截图或技能"
            aria-label="添加"
            aria-haspopup="menu"
            aria-expanded={showAddMenu}
            aria-controls={showAddMenu ? addMenuId : undefined}
          >
            <IconPlusOutline16 size={18} />
          </button>
          {permissionControl}
          </div>
          {busy ? (
            <div className="aipane__send-actions">
              <select aria-label="消息发送方式" value={sendAction} disabled={blocked} onChange={event => setSendAction(event.target.value as 'queue' | 'steer')}>
                <option value="queue">加入队列</option>{onSteer && <option value="steer">引导当前任务</option>}
              </select>
              <Button variant="primary" type="button" className="aipane__send" onClick={sendAction === 'steer' && onSteer ? onSteer : onSubmit} disabled={blocked || (!value.trim() && attachments.length === 0)} aria-label={sendAction === 'steer' ? '引导当前任务' : '加入消息队列'} title={sendAction === 'steer' ? '在当前任务下一步生效' : '当前回复结束后发送'}><IconSendOutline16 size={16} /></Button>
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
