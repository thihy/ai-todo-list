import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AutomationsPane } from './AutomationsPane';
import type { SkillItem } from '../../shared/assistant-capabilities';
import './assistant-capabilities.css';

export function CapabilityIcon({ kind }: { kind: 'automations' | 'skills' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'automations' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2M8 2h8M20 5l1 1" /></> : <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>}</svg>;
}

export const AssistantCapabilities: React.FC<{ onCompose: (prompt: string) => void }> = ({ onCompose }) => {
  const [panel, setPanel] = useState<'automations' | 'skills' | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const automationButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 420, anchor: 360, height: 580 });
  useEffect(() => {
    const open = (event: Event) => { const value = (event as CustomEvent).detail; if (value === 'skills' || value === 'automations') setPanel(value); };
    window.addEventListener('assistant:capability', open);
    return () => window.removeEventListener('assistant:capability', open);
  }, []);
  useEffect(() => { if (panel === 'skills' && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [panel]);
  useLayoutEffect(() => {
    if (panel !== 'automations') return;
    const place = () => {
      const anchor = automationButton.current?.getBoundingClientRect();
      if (!anchor) return;
      if (!anchor.width || !anchor.height || anchor.left < 0 || anchor.right > window.innerWidth || anchor.bottom > window.innerHeight) { setPanel(null); return; }
      const width = Math.min(420, window.innerWidth - 24);
      const left = Math.max(12, Math.min(anchor.right - width + 40, window.innerWidth - width - 12));
      const top = anchor.bottom + 12;
      setPosition({ left, top, width, anchor: Math.max(16, Math.min(width - 16, anchor.left + anchor.width / 2 - left)), height: Math.max(120, Math.min(660, window.innerHeight - top - 16)) });
    };
    place();
    popover.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [panel]);
  useEffect(() => {
    if (panel !== 'automations') return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !automationButton.current?.contains(target)) setPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setPanel(null); automationButton.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [panel]);
  const compose = (prompt: string) => { setPanel(null); onCompose(prompt); };
  return <>
    <button ref={automationButton} type="button" className={'icon-btn' + (panel === 'automations' ? ' is-capability-active' : '')}
      aria-label="自动化" title="自动化清单 · /automations" aria-haspopup="dialog" aria-expanded={panel === 'automations'} aria-controls={panel === 'automations' ? popoverId : undefined}
      onClick={() => setPanel((value) => value === 'automations' ? null : 'automations')}><CapabilityIcon kind="automations" /></button>
    <button type="button" className="icon-btn" aria-label="技能" title="技能 · /skills" onClick={() => setPanel('skills')}><CapabilityIcon kind="skills" /></button>
    {panel === 'automations' && createPortal(<div ref={popover} id={popoverId} className="automation-popover" role="dialog" aria-label="自动化管理" aria-modal="false" tabIndex={-1}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.height, '--automation-anchor': position.anchor + 'px' } as React.CSSProperties}>
      <AutomationsPane onCompose={compose} />
    </div>, document.body)}
    {panel === 'skills' && createPortal(<dialog ref={dialog} className="capability-dialog" aria-label="技能管理" onCancel={() => setPanel(null)}>
      <header className="capability-dialog__header"><div className="capability-dialog__title"><CapabilityIcon kind="skills" /><h2>技能</h2></div><button className="icon-btn" type="button" aria-label="关闭管理面板" onClick={() => setPanel(null)}>×</button></header>
      <div className="capability-dialog__body"><SkillsPane onCompose={compose} /></div>
    </dialog>, document.body)}
  </>;
};

function SkillsPane({ onCompose }: { onCompose: (prompt: string) => void }) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [query, setQuery] = useState(''); const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true); const [installing, setInstalling] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try { const result = await window.todoList.skill.list(); if (!result.ok) throw new Error(result.message); setSkills(result.data); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const install = async () => {
    setInstalling(true); setNotice('');
    try { const result = await window.todoList.skill.install(); if (!result.ok) throw new Error(result.message); if (result.data) { setNotice(`已安装 ${result.data.name}，稍后刷新可查看。`); await new Promise((resolve) => setTimeout(resolve, 600)); await reload(); } }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setInstalling(false); }
  };
  const filtered = skills.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="skills-pane">
    <span className="capability-eyebrow">你的助手，也有拿手好戏</span><h3>让技能随时待命</h3><p className="muted">发现你已安装的全局技能，随时用于当前对话。</p>
    <div className="skills-pane__toolbar"><input className="input" type="search" aria-label="搜索技能" placeholder={`搜索 ${skills.length} 个技能…`} value={query} onChange={(event) => setQuery(event.target.value)} /><button className="btn-secondary" type="button" disabled={loading} onClick={() => { setNotice(''); void reload(); }}>刷新</button><button className="btn-primary" type="button" disabled={installing} onClick={() => void install()}>{installing ? '安装中…' : '安装技能'}</button></div>
    {notice && <p role="status" className="capability-notice">{notice}</p>}
    {loading ? <div className="capability-skeleton" role="status">正在读取技能…</div> : !filtered.length ? <div className="capability-empty"><strong>{query ? '没有匹配的技能' : '把常用方法变成技能'}</strong><p>{query ? '试试其他名称或关键词。' : '选择一个包含 SKILL.md 的文件夹，即可安装。'}</p></div> : <div className="skill-grid">{filtered.map((item) => <article className="skill-card" key={item.name}><div className="skill-card__title"><CapabilityIcon kind="skills" /><strong>{item.name}</strong><span>{item.source === 'custom' ? '全局 / 自定义' : item.source}</span></div><p>{item.description}</p>{item.path && <details><summary>来源目录</summary><code>{item.path}</code></details>}<button className="btn-secondary" type="button" disabled={!item.userInvocable} onClick={() => onCompose(`请使用 ${item.name} 技能，`)}>在对话中使用</button></article>)}</div>}
    <p className="capability-footnote">来自全局与自定义目录 · 权限沿用当前会话</p>
  </section>;
}
