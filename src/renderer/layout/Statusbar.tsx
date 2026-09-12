// Statusbar — bottom strip: active view, counts, AI connection.
//
// AI 状态分三档显示:
//   未配置          → 红色 / 灰色圆点,引导去设置
//   已配置 · 未连接 → 黄色,提示用户后端探活失败(网络/key 错)
//   已配置 · 已连接 → 绿色,带可选 latency

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
 *  branches (not-configured / configured-but-error / connected) without
 *  mounting a Statusbar. */
export function aiStatusLabel(status: ProviderStatus): {
  text: string;
  ariaLabel: string;
  dotClass: string;
} {
  if (!status.configured) {
    return { text: 'AI 未配置', ariaLabel: 'AI 未配置', dotClass: 'dot--off' };
  }
  const c = status.connectivity;
  if (c.state === 'connected') {
    const latency = c.latencyMs != null ? ` · ${c.latencyMs}ms` : '';
    return { text: `AI 已连接${latency}`, ariaLabel: 'AI 已连接', dotClass: 'dot--on' };
  }
  if (c.state === 'error') {
    return { text: 'AI 未连接', ariaLabel: 'AI 已配置但未连接', dotClass: 'dot--warn' };
  }
  // state === 'unknown' | (any other transient): show configured-but-pending.
  return { text: 'AI 配置中…', ariaLabel: 'AI 已配置,正在检查连接', dotClass: 'dot--pending' };
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
