import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clampCaptureRect, type CaptureRect, type ScreenshotState } from '../shared/screenshot';
import './styles/screenshot.css';

function ScreenshotOverlay() {
  const [state, setState] = useState<ScreenshotState | null>(null);
  const [selection, setSelection] = useState<CaptureRect | null>(null);
  const [hover, setHover] = useState<CaptureRect | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; original?: CaptureRect; moved: boolean } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => { void window.todoList.screenshot.state().then(r => { if (r.ok) setState(r.data); else setError(r.message ?? '无法加载截图'); }); }, []);
  const finish = async (rect?: CaptureRect) => {
    if (busy) return;
    setBusy(true);
    const result = await window.todoList.screenshot.finish(rect ? { rect } : {});
    if (!result.ok) { setError(result.message ?? '截图失败'); setBusy(false); }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); void finish(); }
      if (event.key === 'Enter' && selectionRef.current) { event.preventDefault(); void finish(selectionRef.current); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const hit = (x: number, y: number) => state?.windows.find(w => x >= w.x && y >= w.y && x < w.x + w.width && y < w.y + w.height) ?? null;
  const visible = selection ?? hover;
  return <main className="screenshot" aria-label="截图选区"
    onContextMenu={event => { event.preventDefault(); void finish(); }}
    onPointerDown={event => {
      if (!state || busy || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const s = selection;
      const inside = s && event.clientX >= s.x && event.clientX < s.x + s.width && event.clientY >= s.y && event.clientY < s.y + s.height;
      drag.current = { x: event.clientX, y: event.clientY, original: inside ? s : undefined, moved: false };
    }}
    onPointerMove={event => {
      if (!state) return;
      const d = drag.current;
      if (!d) { if (!selection) setHover(hit(event.clientX, event.clientY)); return; }
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      if (Math.hypot(dx, dy) < 3 && !d.moved) return;
      d.moved = true;
      const rect = d.original
        ? { ...d.original, x: Math.max(0, Math.min(state.width - d.original.width, d.original.x + dx)), y: Math.max(0, Math.min(state.height - d.original.height, d.original.y + dy)) }
        : { x: Math.min(d.x, event.clientX), y: Math.min(d.y, event.clientY), width: Math.abs(dx), height: Math.abs(dy) };
      setSelection(clampCaptureRect(rect, state.width, state.height));
    }}
    onPointerUp={event => {
      if (!drag.current) return;
      if (!drag.current.moved && !drag.current.original) setSelection(hit(event.clientX, event.clientY));
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onDoubleClick={event => {
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = selection ?? hit(event.clientX, event.clientY);
      if (rect) void finish(rect);
    }}>
    {state && <img className="screenshot__background" src={state.image} draggable={false} alt="当前屏幕" />}
    <div className="screenshot__instructions">悬停识别窗口 · 拖动框选 · 拖动选区移动 · Enter / 双击确认 · Esc / 右键取消</div>
    {visible ? <div className="screenshot__selection" style={{ left: visible.x, top: visible.y, width: visible.width, height: visible.height }}>
      <span className="screenshot__size">{Math.round(visible.width)} × {Math.round(visible.height)}</span>
    </div> : <div className="screenshot__shade" />}
    {selection && state && <div className="screenshot__toolbar" style={{ left: Math.max(8, Math.min(state.width - 286, selection.x + selection.width - 278)), top: Math.max(8, selection.y + selection.height + 54 < state.height ? selection.y + selection.height + 10 : selection.y - 50) }}>
      <button onClick={() => { setSelection(null); setHover(null); }}>重新选择</button>
      <button onClick={() => void finish()} disabled={busy}>取消</button>
      <button className="screenshot__confirm" onClick={() => void finish(selection)} disabled={busy}>{busy ? '保存中…' : '确认截图'}</button>
    </div>}
    {error && <div className="screenshot__error" role="alert">{error}<button onClick={() => void finish()}>关闭</button></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<ScreenshotOverlay />);
