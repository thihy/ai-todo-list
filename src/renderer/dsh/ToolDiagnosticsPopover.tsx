import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tool-diagnostics.css';

export function ToolDiagnosticsPopover({ text }: { text: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { /* Unstructured legacy details remain available below. */ }
  useEffect(() => {
    if (!position) return;
    const close = () => { setPosition(null); anchor.current?.focus(); };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    const resize = () => close(); window.addEventListener('resize', resize);
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', resize); };
  }, [position]);
  return <><button ref={anchor} type="button" className="tool-diagnostics-trigger" aria-label="查看工具定位信息" title="查看工具定位信息" aria-haspopup="dialog" aria-expanded={!!position} onKeyDown={event => event.stopPropagation()} onClick={event => {
    event.stopPropagation(); if (position) { setPosition(null); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.right - 300, window.innerWidth - 308)), top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 290)) });
  }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg></button>
    {position && createPortal(<div ref={panel} role="dialog" aria-label="定位信息" className="tool-diagnostics-popover" style={{ ...position, maxHeight: Math.max(80, window.innerHeight - position.top - 8) }} onClick={event => event.stopPropagation()}>
      <header><strong>定位信息</strong><button type="button" aria-label="关闭定位信息" onClick={() => { setPosition(null); anchor.current?.focus(); }}>×</button></header>
      <dl><dt>工具名称</dt><dd>{String(data.toolName ?? '未记录')}</dd><dt>调用 ID</dt><dd>{String(data.callId ?? '未记录')}</dd>
        <dt>状态</dt><dd><span className="tool-diagnostics-status">{({ 'missing-result': '缺少结果记录', 'missing-call': '缺少调用记录', stopped: '执行已中止', error: '执行失败' } as Record<string, string>)[String(data.state)] ?? '记录不完整'}</span></dd>
        <dt>输入</dt><dd>{data.argsKnown === true ? '已记录' : '未记录'}</dd><dt>输出</dt><dd>{data.resultKnown === true ? '已记录' : '未记录'}</dd></dl>
      <details><summary>技术详情</summary><pre>{text}</pre></details>
    </div>, document.body)}
  </>;
}
