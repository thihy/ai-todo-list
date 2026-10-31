import { useEffect, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import './compact-progress.css';

export function CompactProgressEditor() {
  const [task, setTask] = useState<Todo | null>(null), [percent, setPercent] = useState('0');
  const [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const id = decodeURIComponent(location.hash.slice('#/compact-progress/'.length));
    void window.todoList.todo.get(id).then(result => {
      if (!alive) return;
      if (!result.ok || !result.data || result.data.deletedAt !== null) { setError('任务不存在或已删除，请关闭后重新选择任务。'); return; }
      setTask(result.data); setPercent(String(result.data.progress));
    }).catch(() => { if (alive) setError('任务读取失败，请关闭后重试。'); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) window.close(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [busy]);
  return <main className="compact-progress-editor">
    <h1>录入进展</h1>
    <p className="compact-progress-editor__title" title={task?.title}>{task?.title ?? (error ? '无法读取任务' : '正在读取任务…')}</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (!task || busy) return;
      const value = Number(percent);
      if (!percent.trim() || !Number.isFinite(value) || value < 0 || value > 100) { setError('请填写 0–100 之间的进度。'); return; }
      setBusy(true); setError('');
      try {
        const result = await window.todoList.progress.log(task.id, value, note.trim() || undefined);
        if (!result.ok) throw Error(result.message ?? '保存失败，请重试');
        window.close();
      } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试'); setBusy(false); }
    }}>
      <label>当前进度<span className="compact-progress-editor__percent"><input aria-label="进度百分比" autoFocus type="number" min="0" max="100" step="any" required disabled={!task || busy} value={percent} onChange={event => setPercent(event.target.value)} /><span>%</span></span></label>
      <label className="compact-progress-editor__note">进展说明<textarea aria-label="进展说明" placeholder="这次完成了什么？下一步准备做什么？" maxLength={4000} disabled={!task || busy} value={note} onChange={event => setNote(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></label>
      {error && <p role="alert" className="compact-progress-editor__error">{error}</p>}
      <footer><span>Ctrl+Enter 保存</span><button type="button" disabled={busy} onClick={() => window.close()}>取消</button><button className="compact-progress-editor__save" type="submit" disabled={!task || busy}>{busy ? '正在保存…' : '保存进展'}</button></footer>
    </form>
  </main>;
}
