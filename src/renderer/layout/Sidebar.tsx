// Sidebar — primary navigation: lists, projects, tags, priorities, settings.
// The AI assistant is a resident right panel, so it has no nav entry here.

import React, { useEffect, useState } from 'react';
import type { Route } from '../router';
import type { Todo } from '../../shared/todo-types';
import { useDataVersion } from '../data-bus';

export const Sidebar: React.FC<{
  route: Route;
  onNavigate: (to: string) => void;
}> = ({ onNavigate }) => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const dataVersion = useDataVersion(['todos']);
  useEffect(() => {
    window.todoList.todo.list({}).then((res) => {
      if (res.ok) setTodos(res.data as Todo[]);
    });
  }, [dataVersion]);

  const isActive = (target: string): boolean => location.hash === target;

  const projects = unique(todos.flatMap((t) => t.tags ?? [])).slice(0, 8);
  const priorities = ['high', 'medium', 'low', 'none'];
  const prioLabel: Record<string, string> = { high: '高', medium: '中', low: '低', none: '无' };

  return (
    <nav className="sidebar" aria-label="主导航">
      <SectionLabel>导航</SectionLabel>
      <NavItem label="全部 TODO" icon="house" target="#/" active={isActive('#/')} onClick={onNavigate} />
      {/* 今天 / 未来 7 天 的"按截止日期"视图被新的"今日待办 / 其他任务"双区
          视图替代（见 TodoListPane 的上半区 / 下半区）；旧的 nav 入口删除。 */}
      <NavItem label="未完成" icon="undone" target="#/list/status/next" active={isActive('#/list/status/next')} onClick={onNavigate} />
      <NavItem label="归档" icon="archive" target="#/list/archived" active={isActive('#/list/archived')} onClick={onNavigate} />
      <NavItem label="已删除" icon="trash" target="#/list/deleted" active={isActive('#/list/deleted')} onClick={onNavigate} />
      <NavItem label="统计" icon="chart" target="#/stats" active={isActive('#/stats')} onClick={onNavigate} />

      <SectionLabel>项目</SectionLabel>
      {projects.length === 0 && <Empty>暂无项目</Empty>}
      {projects.map((p) => (
        <NavItem
          key={p}
          label={p}
          icon="tag"
          target={`#/list/project/${encodeURIComponent(p)}`}
          active={isActive(`#/list/project/${encodeURIComponent(p)}`)}
          onClick={onNavigate}
        />
      ))}

      <SectionLabel>优先级</SectionLabel>
      {priorities.map((p) => (
        <NavItem
          key={p}
          label={prioLabel[p] ?? p}
          icon={`prio-${p}`}
          target={`#/list/priority/${p}`}
          active={isActive(`#/list/priority/${p}`)}
          onClick={onNavigate}
        />
      ))}

      <div className="sidebar__spacer" />
      <NavItem label="设置" icon="gear" target="#/settings" active={isActive('#/settings')} onClick={onNavigate} />
    </nav>
  );
};

const ICONS: Record<string, string> = {
  house: 'M2 8L8 3L14 8V13.5C14 13.78 13.78 14 13.5 14H2.5C2.22 14 2 13.78 2 13.5V8Z',
  today: 'M3 5H13V13H3V5Z M5 2.5V4 M11 2.5V4 M3 7H13',
  week: 'M2.5 12.5L6 8L9 10.5L13.5 4.5',
  undone: 'M1.5 8a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0',
  archive: 'M2.5 3H13.5L14 6H2L2.5 3Z M3.5 6V13H12.5V6 M6.5 8H9.5',
  trash: 'M3 4.5H13 M6.5 4.5V3.2A.5.5 0 01 7 2.7H9A.5.5 0 019.5 3.2V4.5 M5 4.5L5.6 12.5A.5.5 0 006.1 13H9.9A.5.5 0 0010.4 12.5L11 4.5',
  chart: 'M3 13H13 M5 13V9 M8 13V6 M11 13V3',
  tag: 'M3 3H8L13 8L8 13L3 8V3Z',
  'prio-high': 'M8 2L14 14H2L8 2Z',
  'prio-medium': 'M3 3H13V13H3V3Z',
  'prio-low': 'M8 4L12 12H4L8 4Z',
  'prio-none': 'M3 8H13',
  gear: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5Z M8 1V3 M8 13V15 M1 8H3 M13 8H15 M3 3L4.5 4.5 M11.5 11.5L13 13 M3 13L4.5 11.5 M11.5 4.5L13 3',
};

function NavIcon({ name }: { name: string }): React.ReactElement {
  const d = ICONS[name];
  if (!d) return <span className="nav-icon-dot" aria-hidden="true" />;
  return (
    <svg className="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="sidebar__section">{children}</div>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="sidebar__empty">{children}</div>
);

const NavItem: React.FC<{
  label: string;
  icon: string;
  target: string;
  active: boolean;
  onClick: (target: string) => void;
}> = ({ label, icon, target, active, onClick }) => (
  <button
    type="button"
    className={`nav-item${active ? ' is-active' : ''}`}
    onClick={() => onClick(target)}
    aria-current={active ? 'page' : undefined}
  >
    <NavIcon name={icon} />
    <span className="nav-item__label">{label}</span>
  </button>
);

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
