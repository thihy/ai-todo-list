import React, { useEffect, useState } from 'react';
import type { Todo } from '../../shared/todo-types';
import { validateTaskMetadata } from '../../shared/task-metadata';

export const TaskMetadataEditor: React.FC<{ todo: Todo }> = ({ todo }) => {
  const [rows, setRows] = useState<Array<[string, string]>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stored = JSON.stringify(todo.metadata ?? {});
  useEffect(() => { setRows(Object.entries(JSON.parse(stored))); setError(''); }, [todo.id, stored]);
  return <details style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
    <summary style={{ cursor: 'pointer' }}>自定义信息 · Metadata（{Object.keys(todo.metadata ?? {}).length}）</summary>
    <form aria-label="任务元数据" onSubmit={async event => {
      event.preventDefault(); setError('');
      try {
        const keys = rows.map(([key]) => key.trim());
        if (new Set(keys).size !== keys.length) throw new Error('元数据键不能重复');
        const metadata = validateTaskMetadata(Object.fromEntries(rows.map(([key, value]) => [key.trim(), value])));
        setBusy(true); const result = await window.todoList.todo.update(todo.id, { metadata });
        if (!result.ok) throw new Error(result.message); setError('已保存');
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      <p className="muted">记录任务的自定义键值，例如客户、来源或外部编号。</p>
      {rows.map(([key, value], index) => <div key={index} style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
        <input className="input" style={{ width: '30%' }} aria-label={`元数据键 ${index + 1}`} placeholder="键" maxLength={100} value={key} disabled={busy} onChange={event => setRows(previous => previous.map((row, i) => i === index ? [event.target.value, row[1]] : row))} />
        <input className="input" style={{ flex: 1, minWidth: 0 }} aria-label={`元数据值 ${index + 1}`} placeholder="值" maxLength={10000} value={value} disabled={busy} onChange={event => setRows(previous => previous.map((row, i) => i === index ? [row[0], event.target.value] : row))} />
        <button type="button" className="btn-secondary" aria-label={`删除元数据 ${index + 1}`} disabled={busy} onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}>删除</button>
      </div>)}
      <button type="button" className="btn-secondary" disabled={busy || rows.length >= 100} onClick={() => setRows(previous => [...previous, ['', '']])}>添加字段</button>{' '}
      <button type="submit" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存元数据'}</button>
      {error && <p role="status">{error}</p>}
    </form>
  </details>;
};
