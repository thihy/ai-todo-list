import { useState } from 'react';
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives';

interface PendingApprovalCardProps {
  toolName: string;
  reason: string;
  /** DSH agent id == conversationId（dsh-runtime.ts 的 ensureAgent 注释）。
   *  "本次会话允许"路径要把工具名写进 sessionGrantsByConv；没有 conversationId
   *  就只暴露"始终允许"按钮。 */
  conversationId?: string;
  /** ReqId 是主进程 pendingApprovals Map 的 key；grant IPC 内部用 reqId 直接
   *  resolve 当前 waterfall 为 'allowed-once'，所以 grant 按钮不需要再调
   *  onAllow()。 */
  reqId: string;
  preview?: string;
  /** RiskConfirmation 自带 "允许一次" 按钮的回调——resolve 当前 waterfall 为
   *  'allowed-once' 但不写任何 grants 表。 */
  onAllow: () => void;
  onReject: () => void;
}

/** Host adapter around DSH's public risk-confirmation component.
 *
 *  三档授权（OPENSPEC §ai-assistant Persistent and session tool grants）：
 *   1. RiskConfirmation 自带 `允许一次` 按钮 → onAllow()，单次 resolve
 *   2. 本组件 `本次会话允许` 按钮 → ai.userApproval.grantSession IPC，
 *      内部 resolve + 写 sessionGrantsByConv；进程重启失效
 *   3. 本组件 `始终允许此工具` 按钮 → ai.userApproval.grantAlways IPC，
 *      内部 resolve + 写 settings.aiGrantedTools；settings 页面可撤销
 *
 *  Grant IPC 直接 resolve waterfall（不再走 onAllow），所以一旦点击授权
 *  按钮，DSH approval/request 的 90s 超时定时器会被提前清掉。渲染端读
 *  `ok: true, settled: true` 的 IPC 响应作为 ack；UI 不再需要单独 ack 路径。 */
export function PendingApprovalCard({
  toolName,
  reason,
  conversationId,
  reqId,
  preview,
  onAllow,
  onReject,
}: PendingApprovalCardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [granting, setGranting] = useState<'session' | 'always' | null>(null);
  const description = preview ? `${reason}\n\n${preview}` : reason;

  const handleGrantAlways = async (): Promise<void> => {
    if (!reqId || !toolName) return;
    setGranting('always');
    try {
      // 不调 onAllow() —— IPC 内部已 resolve 'allowed-once'
      await window.todoList.aiUserApproval.grantAlways({ reqId, toolName });
    } catch (err) {
      console.error('grantAlways failed', err);
    } finally {
      setGranting(null);
    }
  };

  const handleGrantSession = async (): Promise<void> => {
    if (!reqId || !toolName || !conversationId) return;
    setGranting('session');
    try {
      await window.todoList.aiUserApproval.grantSession({ reqId, toolName, conversationId });
    } catch (err) {
      console.error('grantSession failed', err);
    } finally {
      setGranting(null);
    }
  };

  return (
    <div className="aipane__hitl aipane__hitl--approval" aria-label="AI 请求授权">
      <RiskConfirmation
        open
        title={`AI 想要调用 ${toolName || '敏感操作'}`}
        description={description}
        acknowledgeLabel="我已了解风险"
        cancelLabel="拒绝"
        closeLabel="关闭"
        confirmLabel="允许一次"
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={onReject}
        onConfirm={onAllow}
      />
      <div className="aipane__hitl-grants">
        <button
          type="button"
          className="aipane__hitl-grants-btn"
          disabled={!conversationId || !reqId || granting !== null}
          onClick={handleGrantSession}
        >
          {granting === 'session' ? '允许中…' : '本次会话允许'}
        </button>
        <button
          type="button"
          className="aipane__hitl-grants-btn aipane__hitl-grants-btn--strong"
          disabled={!reqId || granting !== null}
          onClick={handleGrantAlways}
        >
          {granting === 'always' ? '允许中…' : '始终允许此工具'}
        </button>
      </div>
    </div>
  );
}