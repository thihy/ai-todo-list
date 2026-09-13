// 操作卡片 — 用户从「AI 创建任务」界面发起的请求在 AIPane 里显示成一张
// 轻量卡片，而不是普通聊天气泡。
//
// 卡片**只**承载用户视角：
//   - 任务图标 + "创建任务" 标签 + 用户原始描述；
//   - 不显示系统规则、封套前缀、JSON 字段或日期；
//   - 卡片 = 用户发起创建，不等于创建成功——不画勾，不写"已创建"。
//
// 长描述允许换行；不调用模型额外生成摘要。所有长度的描述直接 `<pre>`/`<div>`
// 渲染保留完整可读性，避免产生"读不懂模型为什么要这样改我的输入"的体验。

import React from 'react';
import { IconListCheck } from '../components/icons';

interface Props {
  /** Plain user description (decoded — no protocol prefix / JSON). */
  description: string;
  /** Optional turn id so the host can use the same DOM hooks the plain
   *  user bubble uses (data-user-q / data-turn-id) for the pinned-question
   *  tracker and scroll-tracked banner. */
  turnId: string;
}

/** Render a small action card that visualises a "create task" user intent.
 *  The host wraps this in a `<div className="turn__user-action-card">`
 *  layout cell so the same attachment chip row above is reused — see
 *  TurnView in AIPane.tsx. */
export const AiCreateTaskMessage: React.FC<Props> = ({ description, turnId }) => {
  return (
    <div
      className="ai-create-task-card bubble bubble--user"
      data-user-q
      data-turn-id={turnId}
      role="group"
      aria-label="创建任务请求"
    >
      <span className="ai-create-task-card__head">
        <span className="ai-create-task-card__icon" aria-hidden="true">
          <IconListCheck size={14} />
        </span>
        <span className="ai-create-task-card__label">创建任务</span>
      </span>
      <span className="ai-create-task-card__body">{description}</span>
    </div>
  );
};
