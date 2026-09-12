// Statusbar — bottom strip: active view, counts, AI connection.

import React, { useEffect, useState } from 'react';
import type { Route } from '../router';
import type { Todo } from '../../shared/todo-types';
import { useDataVersion } from '../data-bus';
import { useSettings } from '../hooks/useTodoListApi';
import { isAiProviderConfigured } from '../dsh/provider-status';

const ROUTE_LABEL: Record<string, string> = {
  home: '全部',
  list: '列表',
  todo: '编辑',
  'todo-drawing': '绘图',
  settings: '设置',
  stats: '统计',
  ai: 'AI',
};

export const Statusbar: React.FC<{ route: Route }> = ({ route }) => {
  const [counts, setCounts] = useState<{ open: number; total: number }>({ open: 0, total: 0 });
  const { data: aiSettings } = useSettings();
  const connected = aiSettings !== null && isAiProviderConfigured(aiSettings);
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
      <span className="statusbar__ai" aria-label={connected ? 'AI 已连接' : 'AI 未连接'}>
        <span className={`dot${connected ? ' dot--on' : ''}`} aria-hidden="true" />
        {connected ? 'AI 已连接' : 'AI 未连接'}
      </span>
    </footer>
  );
};
