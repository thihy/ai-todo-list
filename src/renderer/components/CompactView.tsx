import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { localDateKey, selectCompactTasks } from '../../shared/compact-tasks';
import './compact.css';
import { IconRefresh, IconExternal } from './icons';

export const CompactView: React.FC = () => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const result = await window.todoList.todo.list({ status: ['next', 'doing', 'blocked'] });
      if (sequence !== request.current) return;
      if (!result.ok) throw new Error(result.message ?? '待办加载失败');
      setTodos(selectCompactTasks(result.data)); setError(null);
    } catch (cause) {
      if (sequence === request.current) setError(cause instanceof Error ? cause.message : '待办加载失败');
    } finally { if (sequence === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const off = window.todoList.on('app:data-changed', ({ scope }) => { if (scope === 'todos') void refresh(); });
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener('focus', refresh);
    return () => { ++request.current; off(); window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => { if (!loading) void window.todoList.app.compactSize(todos.length); }, [loading, todos.length]);

  const complete = async (todo: Todo): Promise<void> => {
    if (busy.current) return;
    busy.current = true; setBusyId(todo.id);
    try {
      const result = await window.todoList.todo.update(todo.id, { status: 'done' });
      if (!result.ok) throw new Error(result.message ?? '更新失败');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '更新失败'); }
    finally { busy.current = false; setBusyId(null); }
  };
  const restore = async (todoId?: string): Promise<void> => {
    const result = await window.todoList.app.compact(false, todoId);
    if (!result.ok) setError(result.message ?? '打开主窗口失败');
  };
  const today = localDateKey();
  return <main className="compact-view" aria-label="精简待办">
    <header className="compact-view__header" title="置顶显示 · 今日优先 · 按截止时间排序 · 拖动可移动">
      <span className="compact-view__brand-dot" />
      <strong>待办</strong><span className="compact-view__count">{todos.length}</span>
      <div className="compact-view__actions">
        <button type="button" title="刷新待办" aria-label="刷新待办" onClick={() => void refresh()}><IconRefresh size={14} /></button>
        <button type="button" title="展开主窗口" aria-label="展开主窗口" onClick={() => void restore()}>
          <IconExternal size={14} />
        </button>
      </div>
    </header>
    {error && <div className="compact-view__error" role="alert"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
    <ul className="compact-view__list">
      {todos.map((todo) => <li key={todo.id} className="compact-view__row">
        <button type="button" className="compact-view__check" disabled={busyId !== null}
          aria-label={`完成 ${todo.title}`} title="标记完成" onClick={() => void complete(todo)}>{busyId === todo.id ? '·' : ''}</button>
        <button type="button" className="compact-view__task" title={todo.title} onClick={() => void restore(todo.id)}>
          <span className="compact-view__title">{todo.title}</span>
          <span className="compact-view__meta">
            {todo.plannedFor === today && <span className="compact-view__today" title="今日待办">今</span>}
            {todo.dueAt !== null ? <time className={todo.dueAt < Date.now() ? 'is-overdue' : ''} dateTime={new Date(todo.dueAt).toISOString()}>
              {new Date(todo.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
            </time> : null}
          </span>
        </button>
      </li>)}
    </ul>
    {!todos.length && !error && <div className="compact-view__empty">{loading ? '正在读取待办…' : '暂时没有待办，轻松一下。'}</div>}
  </main>;
};
