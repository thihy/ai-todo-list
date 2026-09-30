// TaskListPanel — the left master column wrapper for the task list.
//
// Owns the column's chrome bands:
//   - `.task-list-panel__brand` — the top tools row (notification / search /
//     collapse), fused visually with the Topbar above so the two read as
//     one continuous chrome band. The brand mark + product name live in
//     the Topbar; this row only hosts list-scoped affordances.
//   - `.task-list-panel__body`  — the column's content (currently the
//     TodoListPane: its own add-task header + scrollable task list).
//
// Layout: flex column, height: 100% of its parent (.app-body). The body
// uses flex:1 so it absorbs the remaining space, with the brand
// (flex:none) anchoring the top. (The user-avatar chip moved out of this
// column into the Sidebar rail — see layout/Sidebar.tsx — so the panel
// itself no longer needs a bottom footer.)

import React from 'react';
import { IconBell, IconCollapseBar, IconSearch } from '../components/icons';

export const TaskListPanel: React.FC<{
  onCollapse?: () => void;
  children: React.ReactNode;
}> = ({ onCollapse, children }) => (
  <aside className="task-list-panel" aria-label="任务列表">
    <header className="task-list-panel__brand">
      <div className="task-list-panel__brand-tools">
        <button
          type="button"
          className="task-list-panel__brand-tool"
          aria-label="通知"
          title="通知"
        >
          <IconBell />
        </button>
        <button
          type="button"
          className="task-list-panel__brand-tool"
          aria-label="搜索"
          title="搜索（Ctrl K）"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('app:open-palette'));
          }}
        >
          <IconSearch />
        </button>
        {onCollapse && (
          <button
            type="button"
            className="task-list-panel__brand-tool"
            onClick={onCollapse}
            title="收起任务列表"
            aria-label="收起任务列表"
          >
            <IconCollapseBar />
          </button>
        )}
      </div>
    </header>

    <div className="task-list-panel__body">{children}</div>
  </aside>
);