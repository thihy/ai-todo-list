import React, { useEffect, useRef, useState } from 'react';
import { IconClose, IconDoc, IconExternal, IconLink } from './icons';
import './file-dialog.css';

type LinkDraft = { url: string; title: string; description: string };
export const AddLinkDialog: React.FC<{
  onCancel: () => void; onSave: (draft: LinkDraft) => Promise<void>;
}> = ({ onCancel, onSave }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<'web' | 'local'>('web');
  const [drafts, setDrafts] = useState({ web: { url: '', title: '', description: '' }, local: { url: '', title: '', description: '' } });
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = drafts[kind];
  const update = (patch: Partial<LinkDraft>): void => setDrafts((old) => ({ ...old, [kind]: { ...old[kind], ...patch } }));
  useEffect(() => { dialog.current?.showModal(); }, []);
  const fetchMeta = async (): Promise<void> => {
    const url = draft.url.trim();
    if (kind !== 'web' || !/^https?:\/\//i.test(url)) return;
    setFetching(true);
    try {
      const result = await window.todoList.link.fetchMeta(url);
      if (result.ok) setDrafts((old) => old.web.url.trim() !== url ? old : ({ ...old, web: {
        url: result.data.resolvedUrl || old.web.url, title: old.web.title || result.data.title || '',
        description: old.web.description || result.data.description || '',
      } }));
    } catch { /* Metadata is optional; the URL can still be saved. */ }
    finally { setFetching(false); }
  };
  const pick = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const result = await window.todoList.link.pickFile();
      if (!result.ok) throw new Error(result.message ?? '选择失败');
      if (result.data) update(result.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '选择失败'); }
    finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSave({ url: draft.url.trim(), title: draft.title.trim(), description: draft.description.trim() }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const valid = kind === 'local' ? draft.url.startsWith('file:') : /^https?:\/\/[^\s/]+/i.test(draft.url.trim());
  return <dialog ref={dialog} className="file-dialog link-choice-dialog" aria-labelledby="add-link-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header className="file-dialog__header"><div><h2 id="add-link-title">添加链接</h2><p>保留资料入口，随时回到原处</p></div>
      <button type="button" className="file-dialog__close" aria-label="关闭" disabled={busy} onClick={onCancel}><IconClose size={17} /></button>
    </header>
    <div className="link-choice-dialog__tabs" role="tablist" aria-label="链接类型">
      <button type="button" role="tab" aria-selected={kind === 'web'} disabled={busy} onClick={() => { setKind('web'); setError(null); }}><IconLink size={15} />网页链接</button>
      <button type="button" role="tab" aria-selected={kind === 'local'} disabled={busy} onClick={() => { setKind('local'); setError(null); }}><IconDoc size={15} />本地文件</button>
    </div>
    {kind === 'web' ? <label className="link-choice-dialog__field">网页地址
      <input autoFocus type="url" placeholder="https://example.com" value={draft.url} onChange={(event) => update({ url: event.target.value })} onBlur={() => void fetchMeta()} />
    </label> : <section className="link-choice-dialog__local">
      <span className="file-dialog__upload-mark"><IconExternal size={22} /></span>
      <strong>{draft.url ? draft.title || '已选择本地文件' : '链接到电脑中的文件'}</strong>
      <span>只保存引用，不复制或移动原文件</span>
      <button type="button" className="link-choice-dialog__pick" disabled={busy} onClick={() => void pick()}>选择本地文件链接</button>
      {draft.url && <span className="link-choice-dialog__path" title={draft.url}>{decodeURI(draft.url.replace(/^file:\/\//, ''))}</span>}
    </section>}
    <label className="link-choice-dialog__field">显示名称 <span>可选{fetching ? ' · 获取中…' : ''}</span>
      <input value={draft.title} onChange={(event) => update({ title: event.target.value })} placeholder={kind === 'local' ? '默认使用文件名' : '默认使用网页标题'} />
    </label>
    <label className="link-choice-dialog__field">备注 <span>可选</span>
      <textarea rows={2} value={draft.description} onChange={(event) => update({ description: event.target.value })} placeholder="这份资料有什么用？" />
    </label>
    {error && <p className="file-dialog__error" role="alert">{error}</p>}
    <footer className="link-choice-dialog__footer"><span>{kind === 'local' ? '原文件移动或删除后，链接将失效' : '点击链接会在浏览器中打开'}</span>
      <button type="button" className="file-dialog__primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? '处理中…' : '保存'}</button>
    </footer>
  </dialog>;
};
