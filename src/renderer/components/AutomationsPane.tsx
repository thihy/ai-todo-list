import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Automation, AutomationInput, AutomationSchedule, AutomationSnapshot } from '../../shared/automation-types';
import './automations.css';

const fresh = (): AutomationInput => ({ name: '', prompt: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  enabled: true, schedule: { kind: 'calendar', frequency: 'daily', time: '09:00' } });
const statusLabel = { running: '执行中', succeeded: '成功', failed: '失败', interrupted: '已中断' };
const dateLabel = (time: number, timezone?: string) => new Date(time).toLocaleString('zh-CN', {
  timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const zoneLabel = (timezone: string) => timezone === 'Asia/Shanghai' ? '上海时间' : timezone;
export function automationScheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === 'interval') return '每隔 ' + (schedule.minutes % 60 === 0 ? schedule.minutes / 60 + ' 小时' : schedule.minutes + ' 分钟');
  if (schedule.kind === 'cron') {
    const weekdays = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/.exec(schedule.expression.trim());
    if (weekdays) return '工作日 ' + weekdays[2]!.padStart(2, '0') + ':' + weekdays[1]!.padStart(2, '0');
    return 'Cron · ' + schedule.expression;
  }
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return (schedule.frequency === 'daily' ? '每天 ' : schedule.frequency === 'weekly' ? '每周' + days[schedule.day ?? 1] + ' ' : '每月 ' + (schedule.day ?? 1) + ' 日 ') + schedule.time;
}
function Glyph({ kind }: { kind: 'clock' | 'edit' | 'delete' | 'back' | 'plus' | 'play' }) {
  const paths = { clock: 'M12 7v5l3 2', edit: 'm15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-5-3L4 15v5Z',
    delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7',
    back: 'm10 5-7 7 7 7M3 12h18', plus: 'M12 4v16M4 12h16', play: 'm8 5 11 7-11 7V5Z' };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'clock' && <circle cx="12" cy="12" r="9" />}<path d={paths[kind]} /></svg>;
}

export const AutomationsPane: React.FC<{ onCompose?: (prompt: string) => void }> = ({ onCompose }) => {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>({ automations: [], runs: [] });
  const [draft, setDraft] = useState<AutomationInput>(fresh);
  const [editing, setEditing] = useState<string>();
  const [view, setView] = useState<'list' | 'editor' | 'history'>('list');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  const editorFocus = useRef<HTMLInputElement>(null);
  const editorId = useId();
  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const result = await window.todoList.automation.list();
      if (version !== requestVersion.current) return;
      if (!result.ok) throw new Error(result.message);
      setSnapshot(result.data);
    } catch (error) { if (version === requestVersion.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const unsubscribe = window.todoList.on('app:data-changed', (event) => { if (event.scope === 'automations') void reload(); });
    void reload();
    const timer = setInterval(() => void reload(), 30000);
    return () => { unsubscribe(); clearInterval(timer); requestVersion.current++; };
  }, [reload]);
  useEffect(() => { if (view === 'editor') editorFocus.current?.focus(); }, [view]);
  const action = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true); setError('');
    try { const result = await fn(); if (!result.ok) throw new Error(result.message); await reload(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };
  const schedule = (value: AutomationSchedule) => setDraft({ ...draft, schedule: value });
  const edit = (item?: Automation) => {
    setError(''); setEditing(item?.id); setDraft(item ? { name: item.name, prompt: item.prompt, timezone: item.timezone, enabled: item.enabled, schedule: item.schedule, permissionPreset: item.permissionPreset ?? 'auto' } : fresh()); setView('editor');
  };
  const back = () => { setError(''); setView('list'); setEditing(undefined); };
  const trigger = draft.schedule.kind === 'calendar' ? draft.schedule.frequency : draft.schedule.kind;

  return <section className="automation-manager">
    <header className="automation-manager__header">
      {view === 'list' ? <>
        <div className="automation-manager__heading"><Glyph kind="clock" /><h2>自动化清单</h2><span className="automation-manager__count" aria-label="计划数量">{snapshot.automations.length}</span></div>
        <button className="automation-link" type="button" onClick={() => edit()}><Glyph kind="plus" />新建</button>
      </> : <button className="automation-back" type="button" disabled={busy} onClick={back}><Glyph kind="back" />{view === 'editor' ? editing ? '编辑自动化' : '新建自动化' : '运行记录'}</button>}
    </header>
    {error && <div className="automation-error" role="alert">{error}<button type="button" onClick={() => void reload()}>重新加载</button></div>}
    <div className="automation-manager__body">
      {view === 'list' && <>
        {loading && <div className="automation-empty" role="status">正在读取自动化…</div>}
        {!loading && !snapshot.automations.length && <div className="automation-empty"><strong>还没有自动化</strong><p>设置执行指令与时间，让助手按计划完成。</p>
          {onCompose && <button className="automation-link" type="button" onClick={() => onCompose('帮我创建一个自动化：每个工作日早上 9 点，按优先级整理今日待办并生成行动清单。')}>通过对话创建 →</button>}
          <button className="automation-link" type="button" onClick={() => edit()}>手动创建</button>
        </div>}
        {snapshot.automations.map((item) => {
          const running = snapshot.runs.some((run) => run.automationId === item.id && run.status === 'running');
          return <article className="automation-row" key={item.id}>
            <div className="automation-row__top"><strong title={item.name}>{item.name}</strong><span className={'automation-badge' + (item.enabled ? ' is-enabled' : '')}>{running ? '执行中' : item.enabled ? '已启用' : '已禁用'}</span>
              <button className="automation-switch" role="switch" aria-checked={item.enabled} aria-label={(item.enabled ? '禁用 ' : '启用 ') + item.name} type="button" disabled={busy || running}
                onClick={() => void action(() => window.todoList.automation.save({ ...item, enabled: !item.enabled }, item.id))}><span /></button>
            </div>
            <p className="automation-row__description" title={item.prompt}>{item.prompt}</p>
            <span className="muted">执行权限：{({ auto: 'Auto', 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' })[item.permissionPreset ?? 'auto']}</span>
            <div className="automation-row__schedule"><Glyph kind="clock" /><span>{automationScheduleLabel(item.schedule)}{item.schedule.kind !== 'interval' ? ' · ' + zoneLabel(item.timezone) : ''}</span></div>
            <div className="automation-row__bottom"><span>{item.enabled ? '下次执行：' + (item.nextRunAt ? dateLabel(item.nextRunAt, item.timezone) : '待安排') : '启用后恢复执行'}</span>
              <div className="automation-row__actions">
                <button className="automation-text-action automation-run" type="button" disabled={busy || running} aria-label={running ? '执行中…' : '立即执行 ' + item.name} title="立即执行" onClick={() => void action(() => window.todoList.automation.run(item.id))}><Glyph kind="play" /></button>
                <button className="automation-text-action" type="button" disabled={busy || running} onClick={() => edit(item)}><Glyph kind="edit" />编辑</button>
                <button className="automation-text-action is-danger" type="button" disabled={busy || running} onClick={() => void action(() => window.todoList.automation.remove(item.id))}><Glyph kind="delete" />删除</button>
              </div>
            </div>
          </article>;
        })}
      </>}
      {view === 'editor' && <form id={editorId} className="automation-editor" onSubmit={(event) => { event.preventDefault(); void action(() => window.todoList.automation.save(draft, editing)).then((ok) => { if (ok) back(); }); }}>
        <fieldset disabled={busy}>
          <label>名称<input ref={editorFocus} className="input" required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="automation-editor__description">任务描述 / 执行指令 <span aria-hidden="true" className="automation-required">*</span>
            <textarea className="input" aria-label="任务描述 / 执行指令" aria-describedby={editorId + '-hint'} required rows={5} maxLength={100000} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="描述每次触发时，AI 要完成什么，以及需要读取哪些资料、输出什么结果。" />
          </label>
          <p id={editorId + '-hint'} className="automation-field-hint">每次触发时，AI 将按此指令执行。</p>
          <label>执行时间<select className="input" aria-label="执行时间" value={trigger} onChange={(event) => {
            const value = event.target.value;
            schedule(value === 'interval' ? { kind: 'interval', minutes: 60 } : value === 'cron' ? { kind: 'cron', expression: '0 9 * * 1-5' } : { kind: 'calendar', frequency: value as 'daily' | 'weekly' | 'monthly', time: draft.schedule.kind === 'calendar' ? draft.schedule.time : '09:00', day: 1 });
          }}><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="interval">间隔触发</option><option value="cron">Cron 触发</option></select></label>
          {draft.schedule.kind === 'calendar' && <div className="automation-editor__time">
            {draft.schedule.frequency === 'weekly' && <label>星期<select className="input" aria-label="星期" value={draft.schedule.day ?? 1} onChange={(event) => { if (draft.schedule.kind === 'calendar') schedule({ ...draft.schedule, day: Number(event.target.value) }); }}>{['日', '一', '二', '三', '四', '五', '六'].map((day, index) => <option key={day} value={index}>星期{day}</option>)}</select></label>}
            {draft.schedule.frequency === 'monthly' && <label>每月几号<input className="input" type="number" required min={1} max={31} value={draft.schedule.day ?? 1} onChange={(event) => { if (draft.schedule.kind === 'calendar') schedule({ ...draft.schedule, day: Number(event.target.value) }); }} /></label>}
            <label>时间<input className="input" type="time" required value={draft.schedule.time} onChange={(event) => { if (draft.schedule.kind === 'calendar') schedule({ ...draft.schedule, time: event.target.value }); }} /></label>
          </div>}
          {draft.schedule.kind === 'interval' && <label>间隔（分钟）<input className="input" type="number" min={1} max={525600} required value={draft.schedule.minutes} onChange={(event) => schedule({ kind: 'interval', minutes: Number(event.target.value) })} /></label>}
          {draft.schedule.kind === 'cron' && <label>Cron 表达式<input className="input mono" required value={draft.schedule.expression} onChange={(event) => schedule({ kind: 'cron', expression: event.target.value })} /><span className="automation-field-hint">分 时 日 月 周，例如 0 9 * * 1-5。</span></label>}
          {draft.schedule.kind === 'calendar' && draft.schedule.frequency === 'monthly' && <p className="automation-field-hint">当月没有该日期时跳过。</p>}
          <label>执行权限<select className="input" aria-label="自动化执行权限" value={draft.permissionPreset ?? 'auto'} onChange={async event => {
            const value = event.target.value as AutomationInput['permissionPreset'];
            if (value === 'danger-full-access') { const result = await window.todoList.aiPermissionPreset.confirm({ preset: value }); if (!result.ok || !result.data.confirmed) return; }
            setDraft(previous => ({ ...previous, permissionPreset: value }));
          }}><option value="auto">Auto</option><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问</option></select></label>
          <label>时区<input className="input" required value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} placeholder="Asia/Shanghai" /></label>
          <label className="automation-editor__enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用自动触发</label>
        </fieldset>
      </form>}
      {view === 'history' && <div className="automation-history-list">
        {!snapshot.runs.length && <p className="automation-empty">暂无执行记录。</p>}
        {[...snapshot.runs].reverse().map((run) => <details key={run.id} className="automation-history-row">
          <summary><strong>{run.name}</strong><span>{statusLabel[run.status]} · {dateLabel(run.startedAt)}</span></summary>
          {run.conversationId && <p className="automation-field-hint">对话编号：{run.conversationId}</p>}
          {run.result && <p className="automation-run-result">{run.result}</p>}
        </details>)}
      </div>}
    </div>
    <footer className="automation-manager__footer">
      {view === 'editor' ? <><button className="btn-primary" type="submit" form={editorId} disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>{busy ? '保存中…' : editing ? '保存修改' : '创建自动化'}</button><button className="btn-secondary" type="button" disabled={busy} onClick={back}>取消</button></> :
        <><span>仅在应用运行时执行</span>{view === 'list' && <button className="automation-link" type="button" onClick={() => setView('history')}>查看运行记录 →</button>}</>}
    </footer>
  </section>;
};
