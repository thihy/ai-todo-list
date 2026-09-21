import { useEffect, useId, useRef, useState } from 'react'
import css from './ToolRow.module.css'

/** Native modal provides focus containment, Escape, and focus restoration. */
export function ToolPayloadDialog({ title, text, onClose }: { title: string; text: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // `useState` (not `useState(() => init)`) so StrictMode's dev double-invoke
  // doesn't reset the toggle after a real user click.
  const [copyStatus, setCopyStatus] = useState('复制全文')
  const [formatted, setFormatted] = useState(false)
  let json: string | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') json = JSON.stringify(parsed, null, 2)
  } catch { /* Plain text is a first-class tool result. */ }
  useEffect(() => {
    const node = dialog.current!
    // StrictMode dev double-invoke (mount → cleanup → remount) closes the
    // dialog once via node.close() between the two mounts. Skipping showModal
    // when the dialog is already open lets the second mount leave it open
    // instead of throwing InvalidStateError on a no-op re-entry.
    if (!node.open) node.showModal()
    return () => {
      if (node.open) node.close()
    }
  }, [])
  return (
    // Only bind `onCancel` (Escape). DO NOT bind `onClose` here — the
    // `<dialog>` element fires `close` from `node.close()` AND from any
    // programmatic close; under React 18 StrictMode dev, the cleanup function
    // above runs node.close() between mount and remount, the synthetic
    // `onClose` would fire, the parent would `setPayload(null)`, and the
    // remount would find nothing to mount. The dialog would briefly open
    // then vanish — the user sees the inspect icon as a no-op. The close
    // button below calls onClose itself, which is the only path that should
    // tear the dialog down.
    <dialog ref={dialog} className={css.payloadDialog} aria-labelledby={titleId} onCancel={onClose}>
      <div className={css.payloadHeader}>
        <strong id={titleId}>{title}</strong>
        <button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopyStatus('已复制') }
          catch { setCopyStatus('复制失败，请选择文本复制') }
        }}>{copyStatus}</button>
        {json !== null && <button type="button" aria-pressed={formatted} onClick={() => setFormatted(v => !v)}>{formatted ? '显示原文' : '格式化 JSON'}</button>}
        <button type="button" autoFocus onClick={onClose}>关闭</button>
      </div>
      <pre className={css.payloadText} tabIndex={0}>{formatted ? json : text || '（无输出）'}</pre>
      <span className={css.payloadFooter} role="status">{text.length.toLocaleString()} 字符 · {text.split('\n').length.toLocaleString()} 行</span>
    </dialog>
  )
}
