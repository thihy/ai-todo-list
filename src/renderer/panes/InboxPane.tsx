// Inbox — list of unsorted TODOs that arrived via capture / clipboard / AI.

import React, { useEffect, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { routeToHash } from '../router';
import { useDataVersion } from '../data-bus';

export const InboxPane: React.FC = () => {
  const [items, setItems] = useState<Todo[]>([]);
  const dataVersion = useDataVersion(['todos']);
  useEffect(() => {
    window.thihy.todo.list({ status: ['inbox'] }).then((res) => {
      if (res.ok) setItems(res.data as Todo[]);
    });
  }, [dataVersion]);
  return (
    <div style={{ padding: 'var(--space-lg)' }}>
      <h1 style={{ marginTop: 0 }}>📥 收件箱</h1>
      <p style={{ color: 'var(--fg-muted)' }}>
        所有未分类的 TODO 都会落在这里。点击进入，把它们安排到合适的项目或状态。
      </p>
      {items.length === 0 ? (
        <div style={{ color: 'var(--fg-muted)', marginTop: 'var(--space-xl)' }}>
          🎉 收件箱已清空
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((t) => (
            <li
              key={t.id}
              style={{
                padding: 'var(--space-md)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-sm)',
              }}
            >
              <a href={routeToHash({ name: 'todo', id: t.id })}>{t.title || '(无标题)'}</a>
              <span style={{ marginLeft: 'var(--space-md)', color: 'var(--fg-muted)' }}>
                {new Date(t.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};