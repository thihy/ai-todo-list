import { useState } from 'react';
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives';

interface PendingApprovalCardProps {
  toolName: string;
  reason: string;
  preview?: string;
  onAllow: () => void;
  onReject: () => void;
}

/** Host adapter around DSH's public risk-confirmation component. */
export function PendingApprovalCard({
  toolName,
  reason,
  preview,
  onAllow,
  onReject,
}: PendingApprovalCardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const description = preview ? `${reason}\n\n${preview}` : reason;
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
    </div>
  );
}
