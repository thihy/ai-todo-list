import React, { useEffect, useRef, useState } from 'react';
import { getCommonBounds, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { MinimalExcalidrawApi } from '../drawing/apply';
import { readLiveDrawingContext } from '../drawing/live-context';
import { annotationPosition, annotationPrompt, annotationStorageKey, DRAWING_AI_SUBMIT_EVENT, loadDrawingAnnotations, type DrawingAnnotation } from '../drawing/annotations';
import type { ExternalAiSubmitDetail } from './Composer';
import './drawing-annotations.css';

type Selection = { ids: string[]; versions: Record<string, number>; bounds: [number, number, number, number]; width: number; height: number };
const selectionKey = (ids: string[]) => [...ids].sort().join('\0');

export function DrawingAnnotations({ api, drawingId, host }: { api: MinimalExcalidrawApi | null; drawingId: string; host: React.RefObject<HTMLDivElement> }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const editingTarget = useRef<string[] | null>(null);
  const storageKey = annotationStorageKey(drawingId);
  const [annotations, setAnnotations] = useState<DrawingAnnotation[]>(() => { try { return loadDrawingAnnotations(localStorage.getItem(storageKey)); } catch { return []; } });
  const annotationsRef = useRef(annotations); annotationsRef.current = annotations;
  const [collapsedSelection, setCollapsedSelection] = useState('');
  const [expanded, setExpanded] = useState(false), [submitting, setSubmitting] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(annotations)); } catch { setNotice('草稿暂存失败，请在关闭画布前提交或复制标注。'); } }, [annotations, storageKey]);
  useEffect(() => {
    if (!api) return;
    let signature = '';
    const read = () => {
      const state = api.getAppState(), box = host.current?.getBoundingClientRect();
      const elements = api.getSceneElements() as Array<{ id: string; version?: number }>;
      const selected = state.selectedElementIds as Record<string, boolean> | undefined;
      const values = elements.filter(element => editingTarget.current ? editingTarget.current.includes(element.id) : selected?.[element.id]);
      let next: Selection | null = null;
      if (box && values.length && !state.isLoading && !state.isDragging && !state.isResizing && !state.isRotating && !state.editingTextElement) {
        const bounds = getCommonBounds(values as never, new Map(elements.map(element => [element.id, element])) as never);
        const zoom = (state.zoom as { value?: number })?.value ?? 1;
        const offsetX = Number(state.offsetLeft ?? box.left) - box.left, offsetY = Number(state.offsetTop ?? box.top) - box.top;
        const scrollX = Number(state.scrollX ?? 0), scrollY = Number(state.scrollY ?? 0);
        next = { ids: values.map(element => element.id), versions: Object.fromEntries(values.map(element => [element.id, element.version ?? 0])),
          bounds: [(bounds[0] + scrollX) * zoom + offsetX, (bounds[1] + scrollY) * zoom + offsetY, (bounds[2] + scrollX) * zoom + offsetX, (bounds[3] + scrollY) * zoom + offsetY], width: box.width, height: box.height };
      }
      const serialized = JSON.stringify(next);
      if (serialized !== signature) { signature = serialized; setSelection(next); }
    };
    const off = api.onChange?.(read); const observer = new ResizeObserver(read);
    const element = host.current;
    const unlock = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.drawing-annotations')) return;
      editingTarget.current = null;
    };
    if (element) { observer.observe(element); element.addEventListener('pointerdown', unlock, true); element.addEventListener('keydown', unlock, true); }
    read();
    return () => { off?.(); observer.disconnect(); element?.removeEventListener('pointerdown', unlock, true); element?.removeEventListener('keydown', unlock, true); };
  }, [api, host]);
  const key = selection ? selectionKey(selection.ids) : '';
  const active = annotations.find(annotation => selectionKey(annotation.elementIds) === key);
  const pending = annotations.filter(annotation => annotation.text.trim());
  const updateText = (value: string) => {
    if (!selection) return;
    if (!active && annotationsRef.current.length >= 50) { setNotice('最多暂存 50 条标注，请先提交或删除部分标注。'); return; }
    setNotice('');
    const draftId = active?.id ?? crypto.randomUUID();
    setAnnotations(previous => {
      const existing = previous.find(annotation => selectionKey(annotation.elementIds) === key);
      const next = { id: existing?.id ?? draftId, elementIds: selection.ids, versions: selection.versions, text: value };
      return existing ? previous.map(annotation => annotation.id === existing.id ? next : annotation) : [...previous, next];
    });
  };
  const highlight = (annotation: DrawingAnnotation) => {
    if (!api) return;
    editingTarget.current = null;
    const elements = api.getSceneElements() as Array<{ id: string }>;
    const targets = elements.filter(element => annotation.elementIds.includes(element.id));
    if (targets.length !== annotation.elementIds.length) { setNotice('这条标注的部分目标已删除，请修改或删除标注。'); return; }
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(targets.map(element => [element.id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    api.scrollToContent?.(targets); setCollapsedSelection('');
  };
  const submit = async () => {
    if (!api || !pending.length || submitting) return;
    setSubmitting(true); setNotice('正在提交标注…');
    try {
      const batch = [...pending]; const prompt = annotationPrompt(drawingId, batch, await readLiveDrawingContext(api, drawingId));
      await new Promise<void>((resolve, reject) => {
        const detail: ExternalAiSubmitDetail = { intent: 'chat', requestId: crypto.randomUUID(), prompt, images: [],
          onAdmitted: () => {
            editingTarget.current = null;
            const sent = new Set(batch.map(annotation => annotation.id));
            const remaining = annotationsRef.current.filter(annotation => !sent.has(annotation.id));
            try { localStorage.setItem(storageKey, JSON.stringify(remaining)); } catch { /* In-memory drafts remain authoritative. */ }
            setAnnotations(remaining); resolve();
          }, onRejected: message => reject(Error(message)) };
        window.dispatchEvent(new CustomEvent(DRAWING_AI_SUBMIT_EVENT, { detail }));
      });
      setNotice(`已提交 ${batch.length} 条标注，可在 AI 助手中查看执行或队列。`); setExpanded(false); setCollapsedSelection(key);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '提交失败，标注已保留。'); }
    finally { setSubmitting(false); }
  };
  return <div className="drawing-annotations" aria-label="绘图 AI 标注">
    {selection && <section className="drawing-annotation-composer" style={annotationPosition(selection.bounds, selection)} aria-label="选区 AI 标注">
      <header><button type="button" onClick={() => setCollapsedSelection(collapsedSelection === key ? '' : key)} aria-expanded={collapsedSelection !== key}>AI 标注 <span>· {selection.ids.length} 个元素</span></button><button type="button" aria-label="收起标注输入" title="收起标注输入" onClick={() => setCollapsedSelection(key)}>×</button></header>
      {collapsedSelection !== key && <><textarea aria-label="AI 标注内容" placeholder="想怎么修改这些元素？" value={active?.text ?? ''} disabled={submitting} maxLength={4000} onFocus={() => { editingTarget.current = selection.ids; }} onChange={event => updateText(event.target.value)} onKeyDown={event => {
        event.stopPropagation(); if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); setCollapsedSelection(key); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (active?.text.trim()) { setCollapsedSelection(key); setNotice('标注已暂存，可继续选择其他元素。'); } }
      }} /><footer><span>Enter 暂存 · Shift+Enter 换行</span><button type="button" disabled={!active?.text.trim() || submitting} onClick={() => { setCollapsedSelection(key); setNotice('标注已暂存，可继续选择其他元素。'); }}>暂存</button></footer></>}
    </section>}
    {pending.length > 0 && <aside className="drawing-annotation-batch" aria-label="待提交标注">
      <header><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>标注 <strong>{pending.length}</strong> <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button><button type="button" className="drawing-annotation-submit" onClick={() => void submit()} disabled={submitting}>{submitting ? '正在提交…' : '提交给 AI'}</button></header>
      {expanded && <ol>{pending.map((annotation, index) => <li key={annotation.id}><div><button type="button" onClick={() => highlight(annotation)} title="定位并选中标注元素">{index + 1} · {annotation.elementIds.length} 个元素</button><button type="button" disabled={submitting} aria-label={`删除标注 ${index + 1}`} onClick={() => setAnnotations(previous => previous.filter(item => item.id !== annotation.id))}>×</button></div><textarea aria-label={`编辑标注 ${index + 1}`} maxLength={4000} disabled={submitting} value={annotation.text} onChange={event => setAnnotations(previous => previous.map(item => item.id === annotation.id ? { ...item, text: event.target.value } : item))} /></li>)}</ol>}
    </aside>}
    {notice && <div className="drawing-annotation-notice" role="status" aria-live="polite">{notice}<button type="button" aria-label="关闭标注提示" onClick={() => setNotice('')}>×</button></div>}
  </div>;
}
