// AI Panel — React components replacing the previous <webview>/WebContentsView
// embed of @deepseek-ai/dsh-web-frontend. We now import UI atoms directly
// from @deepseek-ai/dsh-client-ui-primitives (Button, Pill, MarkdownText, …)
// — no embedded sub-document, no custom protocol, no IPC layout dance.
//
// Scope note: this is a SCAFFOLD. The full chat UI (conversation list,
// streaming message bubbles, tool-call rendering, HITL answerer surface,
// permission prompts) is the next-step work. The AI runtime backend (DSH
// container, TodoListLlmAdapter, ai.ask / ai:stream IPC) is unchanged and
// can drive a React chat surface the same way it would drive the embedded
// web frontend — only the rendering layer is different now. Until that
// surface lands, this panel renders an honest "scaffolded" placeholder
// using DSH primitives so the user can see the integration works.

import React from 'react';
import { Button, MarkdownText, Pill, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';

const PANEL_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
};

const WELCOME = `# AI 助手（占位）

本面板正在从内嵌的 DSH Web 前端迁移到 **组件级复用** @deepseek-ai/dsh-client-ui-primitives 的 React 原子。

- 聊天 / 流式 / 工具调用 / HITL 渲染：待实现
- AI 后端（DSH container、TodoListLlmAdapter、ai.ask IPC）保持不变
- 当 React 聊天界面完成后，此面板可直接接入现有 \`ai:stream\` 事件

详见仓库根目录的迁移计划。`;

export const AIPane: React.FC = () => {
  return (
    <div className="ai-pane__react" role="region" aria-label="AI 助手">
      <div className="ai-pane__react-header">
        <Pill className="ai-pane__react-pill">Scaffold</Pill>
        <h2 className="ai-pane__react-title">AI 助手</h2>
      </div>
      <div className="ai-pane__react-body">
        <MarkdownText text={WELCOME} labels={PANEL_LABELS} />
      </div>
      <div className="ai-pane__react-actions">
        <Button variant="ghost" disabled>
          新建会话（待实现）
        </Button>
        <Button variant="primary" disabled>
          发送给 AI（待实现）
        </Button>
      </div>
    </div>
  );
};
