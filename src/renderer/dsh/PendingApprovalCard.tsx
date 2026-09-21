import { useState } from 'react';
import { Modal, Button } from '@deepseek-ai/dsh-client-ui-primitives';

interface PendingApprovalCardProps {
  toolName: string;
  reason: string;
  conversationId?: string;
  reqId: string;
  preview?: string;
  onAllow: () => void;
  onReject: () => void;
}

/** Approval is bound to this pending request, never to a whole tool. */
export function PendingApprovalCard({ toolName, reason, preview, onAllow, onReject }: PendingApprovalCardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const description = preview ? `${reason}\n\n${preview}` : reason;
  return (
    <Modal open title={`AI 想要调用 ${toolName || '敏感操作'}`} closeLabel="关闭" onClose={onReject}
      footer={<div className="aipane__approval-actions">
        <Button variant="outline" onClick={onReject}>不允许</Button>
        <Button variant="primary" disabled={!acknowledged} onClick={onAllow}>本次允许</Button>
      </div>}
    >
      <p className="aipane__approval-description">{description}</p>
      <p>仅批准当前操作，不授权该工具的后续调用。</p>
      <label><input type="checkbox" autoFocus checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> 我已了解本次操作</label>
    </Modal>
  );
}
