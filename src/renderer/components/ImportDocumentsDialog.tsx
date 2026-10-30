import React, { useEffect, useRef, useState } from 'react';
import { IconClose, IconDoc, IconDrawing, IconImport } from './icons';
import './file-dialog.css';

export const ImportDocumentsDialog: React.FC<{
  todoId: string; onClose: () => void; onImported: () => Promise<void>;
}> = ({ todoId, onClose, onImported }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const importing = useRef(false);
  const run = async (files?: File[]): Promise<void> => {
    if (importing.current) return;
    setError(null);
    if (files && (!files.length || files.some((file) => !/\.(md|excalidraw)$/i.test(file.name)))) {
      setError('仅支持 .md 和 .excalidraw 文件，请重新选择。');
      return;
    }
    importing.current = true;
    setBusy(true);
    try {
      const paths = files ? window.todoList.document.pathsForFiles(files) : undefined;
      if (paths?.some((path) => !path)) throw new Error('请拖入本地文件。');
      const result = await window.todoList.document.import(todoId, paths);
      if (!result.ok) throw new Error(result.message ?? '导入失败');
      if (result.data.files.length) {
        await onImported();
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      importing.current = false;
      setBusy(false);
    }
  };
  return <dialog ref={dialog} className="file-dialog" aria-labelledby="import-documents-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}>
    <header className="file-dialog__header">
      <div><h2 id="import-documents-title">导入文档</h2><p>把已有内容带到当前任务</p></div>
      <button className="file-dialog__close" type="button" disabled={busy} aria-label="关闭" onClick={onClose}><IconClose size={17} /></button>
    </header>
    <div className={`file-dialog__drop${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`} aria-busy={busy}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); void run(Array.from(event.dataTransfer.files)); }}>
      <span className="file-dialog__upload-mark"><IconImport size={25} /></span>
      <strong>{dragging ? '松开即可导入' : '将文件拖到这里'}</strong>
      <span className="file-dialog__or">或从电脑中选择，支持多选</span>
      <button className="file-dialog__primary" type="button" disabled={busy} onClick={() => void run()}>{busy ? '正在导入…' : '选择本地文件'}</button>
    </div>
    <section className="file-dialog__formats" aria-label="支持的文件格式">
      <span><IconDoc size={14} /> Markdown <code>.md</code></span>
      <span><IconDrawing size={14} /> Excalidraw <code>.excalidraw</code></span>
    </section>
    {error && <p className="file-dialog__error" role="alert">{error}</p>}
    <footer className="file-dialog__footer">文件将复制到此任务，同名自动编号，原文件保留。</footer>
  </dialog>;
};
