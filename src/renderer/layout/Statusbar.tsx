// Statusbar — bottom strip: active view, counts, AI configuration.
//
// AI 状态只显示"配置是否齐全",不探测网络连通性。
//   loading        → 中性样式,等待 settings IPC 首次返回
//   not-configured → 引导去设置
//   configured     → 中性样式,不暗示"已连接"
// 真实请求失败由该轮回答的错误展示承担——不在状态栏常驻"未连接"标签,
// 否则 /models 拒绝的自定义服务会被误报成全局告警。

import React, { useEffect, useState } from 'react';
import type { Route } from '../router';
import type { Todo } from '../../shared/todo-types';
import { useDataVersion } from '../data-bus';
import { useProviderStatus } from '../hooks/useTodoListApi';
import type { ProviderStatus } from '../dsh/provider-status';

const ROUTE_LABEL: Record<string, string> = {
  home: '全部',
  list: '列表',
  todo: '编辑',
  'todo-drawing': '绘图',
  settings: '设置',
  stats: '统计',
  ai: 'AI',
};

/** Render the AI status pill. Pure function so we can unit-test the three
 *  branches (loading / not-configured / configured) without mounting a
 *  Statusbar. */
export function aiStatusLabel(status: ProviderStatus): {
  text: string;
  ariaLabel: string;
  dotClass: string;
} {
  if (status.state === 'loading') {
    return { text: 'AI 状态加载中', ariaLabel: 'AI 状态加载中', dotClass: 'dot--pending' };
  }
  if (status.state === 'not-configured') {
    return { text: 'AI 未配置', ariaLabel: 'AI 未配置', dotClass: 'dot--off' };
  }
  // configured —— 中性样式,不带"已连接 / latency"等隐含承诺。
  return { text: 'AI 已配置', ariaLabel: 'AI 已配置', dotClass: 'dot--on' };
}

export const Statusbar: React.FC<{ route: Route }> = ({ route }) => {
  const [counts, setCounts] = useState<{ open: number; total: number }>({ open: 0, total: 0 });
  const status = useProviderStatus();
  const ai = aiStatusLabel(status);
  const dataVersion = useDataVersion(['todos']);
  const listFilterKind = route.name === 'list' ? route.filter.kind : '';
  useEffect(() => {
    window.todoList.todo.list({}).then((res) => {
      if (res.ok) {
        const all = res.data as Todo[];
        setCounts({
          total: all.length,
          open: all.filter((t) => t.status !== 'done').length,
        });
      }
    });
  }, [route.name, listFilterKind, dataVersion]);

  return (
    <footer className="statusbar">
      <span className="statusbar__view">{ROUTE_LABEL[route.name] ?? route.name}</span>
      <span className="statusbar__sep" aria-hidden="true">·</span>
      <span>{counts.open} 未完成 / {counts.total} 总计</span>
      <span className="statusbar__ai" aria-label={ai.ariaLabel} title={ai.ariaLabel}>
        <span className={`dot ${ai.dotClass}`} aria-hidden="true" />
        {ai.text}
      </span>
    </footer>
  );
};
