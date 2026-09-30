// TaskListPanel — the left master column wrapper for the task list.
//
// It is a **layout shell, not a chrome owner**: the column's width, its right
// border, and the vertical flex scaffold. The visible chrome (the add-task
// row and its tool cluster: 通知 / 搜索 / 收起 / 全部展开折叠) all lives
// inside the TodoListPane it wraps — there used to be a separate
// `.task-list-panel__brand` band above the add-task row, but two stacked
// header rows wasted 44px of vertical space and read as two unrelated
// strips, so the tools moved into the add-task row instead.
//
// WIDTH: `width` is applied HERE as an inline style, not on the inner
// TodoListPane. This element is the flex child of .master-detail, so it is
// what the PaneDivider drag actually resizes. If the width lived on the
// inner pane instead, the pane would resize inside a fixed-width wrapper
// and the wrapper's `overflow: hidden` would clip the change — the drag
// would update state but nothing on screen would move. Keep the CSS width
// unset so the inline value wins.

import React from 'react';

export const TaskListPanel: React.FC<{
  width: number;
  children: React.ReactNode;
}> = ({ width, children }) => (
  <aside className="task-list-panel" aria-label="任务列表" style={{ width }}>
    <div className="task-list-panel__body">{children}</div>
  </aside>
);
