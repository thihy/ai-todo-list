// Shared status vocabulary + glyph. Extracted from TodoListPane so the
// detail editor's inline status pill reuses the exact same colours, labels,
// and lifecycle cycle as the list row — one source of truth for how a
// TodoStatus looks and reads across surfaces.

import React from 'react';
import type { TodoStatus } from '../../shared/todo-types';

export const STATUS_LABEL: Record<TodoStatus, string> = {
  next: '未完成',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
  blocked: '阻塞中',
};

// Click the status to cycle forward through the lifecycle. The two
// "off-track" terminal states (已取消 / 阻塞中) are in the cycle so a single
// click can reach them without a separate UI; the cycle returns to 未完成
// after 阻塞中 so nothing gets stuck.
export function nextStatus(s: TodoStatus): TodoStatus {
  const order: TodoStatus[] = ['next', 'doing', 'done', 'cancelled', 'blocked'];
  const idx = order.indexOf(s);
  if (idx < 0) return 'next';
  return order[(idx + 1) % order.length];
}

export const StatusGlyph: React.FC<{ status: TodoStatus }> = ({ status }) => {
  switch (status) {
    case 'done':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="8" fill="var(--accent-success)" />
          <path d="M5.5 9.2L8 11.5L12.5 6.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'doing':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--accent-primary)" strokeWidth="1.6" />
          <path d="M9 1.8A7.2 7.2 0 0116.2 9H9z" fill="var(--accent-primary)" />
        </svg>
      );
    case 'next':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--fg-secondary)" strokeWidth="1.6" />
          <circle cx="9" cy="9" r="2.6" fill="var(--accent-primary)" />
        </svg>
      );
    case 'blocked':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--accent-danger)" strokeWidth="1.6" />
          <path d="M4 4L14 14" stroke="var(--accent-danger)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--fg-secondary)" strokeWidth="1.6" />
          <path d="M5 9H13" stroke="var(--fg-secondary)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="var(--border-strong)" strokeWidth="1.6" />
        </svg>
      );
  }
};
