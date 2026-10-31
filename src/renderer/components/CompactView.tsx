import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { localDateKey, selectCompactTasks } from '../../shared/compact-tasks';
import './compact.css';
import { IconRefresh, IconExternal, IconMore, IconClose } from './icons';

export const CompactView: React.FC = () => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const [capacity, setCapacity] = useState(0);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setCapacity(Math.max(0, Math.floor(list.clientHeight / 26)));
    const observer = new ResizeObserver(measure);
    observer.observe(list); measure();
    return () => observer.disconnect();
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [interaction, setInteraction] = useState({ active: false, opacity: .6, titleHovered: false });
  useEffect(() => {
    const off = window.todoList.on('app:compact-interaction', setInteraction);
    void window.todoList.app.compactConfigure({}).then(result => { if (result.ok) setInteraction(previous => ({ ...previous, opacity: result.data.opacity })); });
    return off;
  }, []);
  const [menu, setMenu] = useState<Todo | null>(null);
  const [progressTask, setProgressTask] = useState<Todo | null>(null);
  const [percent, setPercent] = useState(0);
  const [note, setNote] = useState('');
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

  const update = async (todo: Todo, patch: Partial<Pick<Todo, 'status' | 'priority'>>): Promise<void> => {
    if (busy.current) return;
    busy.current = true; setBusyId(todo.id);
    try {
      const result = await window.todoList.todo.update(todo.id, patch);
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
  const idleOpacity = interaction.opacity;
  return <main className="compact-view" aria-label="精简待办" data-active={interaction.active} style={{ '--compact-body-opacity': interaction.active ? 1 : idleOpacity, '--compact-title-opacity': interaction.active || interaction.titleHovered ? 1 : 1 - (1 - idleOpacity) / 2 } as React.CSSProperties}>
    <header className="compact-view__header" title="置顶显示 · 今日优先 · 按截止时间排序 · 拖动可移动">
      <span className="compact-view__brand-dot" />
      <strong>待办</strong><span className="compact-view__count" title={`当前显示 ${Math.min(capacity, todos.length)} 条，共 ${todos.length} 条；拖高窗口可显示更多`}>{Math.min(capacity, todos.length)}{todos.length > capacity ? `/${todos.length}` : ''}</span>
      <div className="compact-view__actions">
        <button type="button" aria-label="关闭悬浮窗" title="关闭悬浮窗" onClick={() => void window.todoList.app.compactConfigure({ enabled: false })}><IconClose size={14} /></button>
        <button type="button" title="悬浮设置 · 透明度" aria-label="悬浮设置" onClick={() => void window.todoList.app.compactMenu()}>
          <IconMore size={14} />
        </button>
        <button type="button" title="刷新待办" aria-label="刷新待办" onClick={() => void refresh()}><IconRefresh size={14} /></button>
        <button type="button" title="展开主窗口" aria-label="展开主窗口" onClick={() => void restore()}>
          <IconExternal size={14} />
        </button>
      </div>
    </header>
    <div className="compact-view__content">
    {error && <div className="compact-view__error" role="alert"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
    <ul ref={listRef} className="compact-view__list">
      {todos.slice(0, capacity).map((todo) => <li key={todo.id} className={`compact-view__row priority-${todo.priority}`}>
        <button type="button" className="compact-view__task" aria-label={`${todo.title}，优先级 ${todo.priority}`} title={`${todo.title} · 右键操作`} onContextMenu={event => { event.preventDefault(); setMenu(todo); }} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenu(todo); } }} onClick={() => void restore(todo.id)}>
          <span className="compact-view__task-dot" aria-hidden="true" /><span className="compact-view__title">{todo.title}</span>
          <span className="compact-view__meta">
            {todo.plannedFor === today && <span className="compact-view__today" title="今日待办">今</span>}
            {todo.dueAt !== null ? <time className={todo.dueAt < Date.now() ? 'is-overdue' : ''} dateTime={new Date(todo.dueAt).toISOString()}>
              {new Date(todo.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
            </time> : null}
          </span>
        </button>
      </li>)}
    </ul>
    {menu && <div className="compact-task-overlay" onClick={() => setMenu(null)} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
      <div className="compact-task-menu" role="dialog" aria-label="任务快捷操作" onClick={event => event.stopPropagation()}>
        <strong>{menu.title}</strong>
        {([['done', '标记完成'], ['doing', '开始处理'], ['blocked', '标记阻塞'], ['next', '恢复待办'], ['cancelled', '取消任务']] as const).map(([status, label]) => <button autoFocus={status === 'done'} key={status} disabled={busyId !== null} onClick={() => { void update(menu, { status }); setMenu(null); }}>{label}</button>)}
        <label>优先级<select aria-label="修改优先级" value={menu.priority} disabled={busyId !== null} onChange={event => { void update(menu, { priority: event.target.value as Todo['priority'] }); setMenu(null); }}>
          {(['very-high', 'high', 'medium', 'low', 'very-low'] as const).map((priority, index) => <option key={priority} value={priority}>{['极高', '高', '中', '低', '极低'][index]}</option>)}
        </select></label>
        <button onClick={() => { setProgressTask(menu); setPercent(menu.progress); setNote(''); setMenu(null); }}>录入进展</button>
        <button onClick={() => setMenu(null)}>关闭菜单</button>
      </div>
    </div>}
    {progressTask && <form className="compact-progress" aria-label="录入进展" onSubmit={async event => {
      event.preventDefault(); if (busy.current) return; busy.current = true; setBusyId(progressTask.id);
      try { const result = await window.todoList.progress.log(progressTask.id, percent, note.trim() || undefined); if (!result.ok) throw new Error(result.message); setProgressTask(null); await refresh(); }
      catch (cause) { setError(String(cause)); } finally { busy.current = false; setBusyId(null); }
    }}><strong>{progressTask.title}</strong><label>进度 %<input autoFocus aria-label="进度百分比" type="number" min="0" max="100" required value={percent} onChange={event => setPercent(Number(event.target.value))} /></label>
      <textarea aria-label="进展说明" placeholder="记录本次进展" value={note} onChange={event => setNote(event.target.value)} />
      <button disabled={busyId !== null} type="submit">保存进展</button><button disabled={busyId !== null} type="button" onClick={() => setProgressTask(null)}>取消</button>
    </form>}
    {!todos.length && !error && <div className="compact-view__empty">{loading ? '正在读取待办…' : '暂时没有待办，轻松一下。'}</div>}
    </div>
  </main>;
};
