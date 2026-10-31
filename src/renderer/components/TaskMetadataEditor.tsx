import React, { useEffect, useRef, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { validateTaskMetadata } from '../../shared/task-metadata';

export const TaskMetadataEditor: React.FC<{ todo: Todo }> = ({ todo }) => {
  const [rows, setRows] = useState<Array<[string, string]>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const valuesRef = useRef<HTMLSpanElement>(null);
  const stored = JSON.stringify(todo.metadata ?? {});
  useEffect(() => { setRows(Object.entries(JSON.parse(stored))); setError(''); }, [todo.id, stored]);
  const entries = Object.entries(todo.metadata ?? {});
  const summary = entries.map(([key, value]) => `${key}=${value}`).join('，');
  useEffect(() => {
    const node = valuesRef.current; if (!node || expanded) return;
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [summary, expanded]);
  return <section className="editor-pane__section task-extra-info" aria-label="附加">
    <div className="task-extra-info__line"><h2 className="editor-pane__section-title">附加</h2><span ref={valuesRef} className={expanded ? 'task-extra-info__values is-expanded' : 'task-extra-info__values'} title={summary}>{summary || '暂无附加信息'}</span>
      {!!entries.length && (overflow || expanded) && <button type="button" className="task-extra-info__more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '更多'}</button>}
      <button type="button" className="task-extra-info__edit" onClick={() => { setRows(Object.entries(todo.metadata ?? {})); setError(''); setEditing(value => !value); }}>{editing ? '收起编辑' : entries.length ? '编辑' : '添加'}</button>
    </div>
    {editing && <form aria-label="任务元数据" onSubmit={async event => {
      event.preventDefault(); setError('');
      try {
        const keys = rows.map(([key]) => key.trim());
        if (new Set(keys).size !== keys.length) throw new Error('元数据键不能重复');
        const metadata = validateTaskMetadata(Object.fromEntries(rows.map(([key, value]) => [key.trim(), value])));
        setBusy(true); const result = await window.todoList.todo.update(todo.id, { metadata });
        if (!result.ok) throw new Error(result.message); setError('已保存'); setEditing(false); setExpanded(false);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      {rows.map(([key, value], index) => <div key={index} style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
        <input className="input" style={{ width: '30%' }} aria-label={`元数据键 ${index + 1}`} placeholder="键" maxLength={100} value={key} disabled={busy} onChange={event => setRows(previous => previous.map((row, i) => i === index ? [event.target.value, row[1]] : row))} />
        <input className="input" style={{ flex: 1, minWidth: 0 }} aria-label={`元数据值 ${index + 1}`} placeholder="值" maxLength={10000} value={value} disabled={busy} onChange={event => setRows(previous => previous.map((row, i) => i === index ? [row[0], event.target.value] : row))} />
        <button type="button" className="btn-secondary" aria-label={`删除元数据 ${index + 1}`} disabled={busy} onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}>删除</button>
      </div>)}
      <button type="button" className="btn-secondary" disabled={busy || rows.length >= 100} onClick={() => setRows(previous => [...previous, ['', '']])}>添加字段</button>{' '}
      <button type="submit" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      {error && <p role="status">{error}</p>}
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setRows(entries); setError(''); setEditing(false); }}>取消</button>
    </form>}
  </section>;
};
