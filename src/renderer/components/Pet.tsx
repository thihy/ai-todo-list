// Floating pet — Shishi (拾拾), a small mascot in a transparent
// always-on-top window. The character itself is rendered by the
// shishi-pet.js SVG component, which owns every motion (breathing,
// ear sway, pouch glow, sorting cards, sleeping, success rays).
//
// Drag/drop, IPC, and the surrounding state machine stay here in
// React because they have to talk to Electron. The character only
// needs to be told which mood to display.
//
// Pipeline: dragover → submitting → thinking → done | hitl-pending
// | error. ai:stream events are correlated by invocationId so the
// pet can show real-time feedback WITHOUT focusing the main window.
// State is carried by Shishi's own visuals, NOT by a text label. The
// whole 132×132 body is the drop target; the aura behind is the
// "drop here" hint and is our only decoration outside the SVG.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PetFileRef } from '../../shared/todo-list-api';
import { readDropPayload } from '../utils/drop';
import type { ShishiState } from './shishi-pet.js';
import { shishiPetSvg } from './shishi-pet.js';

type PetState =
  | 'idle'
  | 'dragover'
  | 'submitting'
  | 'thinking'
  | 'done'
  | 'hitl-pending'
  | 'error';

interface SessionState {
  invocationId: string;
  phase: 'submitting' | 'thinking' | 'done' | 'hitl' | 'error';
  createdTitle: string | null;
  errorMsg: string | null;
}

const DONE_DISMISS_MS = 4500;
const ERROR_DISMISS_MS = 6000;

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Map our pipeline state to Shishi's five built-in states. */
function shishiStateFor(state: PetState): ShishiState {
  switch (state) {
    case 'dragover':
      return 'receiving';
    case 'submitting':
    case 'done':
      // Captured: pouch-glow + success rays. Submitting = "got it",
      // done = "all done!". Both share the celebration visual.
      return 'captured';
    case 'thinking':
      return 'sorting';
    case 'hitl-pending':
      // Sleeping body, but the reminder dot stays lit — exactly the
      // "I'm not pushing, but I haven't forgotten" posture Shishi was
      // designed for.
      return 'sleeping';
    case 'idle':
    case 'error':
    default:
      // No built-in error pose. Calmed body + text caption in the UI
      // is the clearest fallback.
      return 'idle';
  }
}

export const Pet = () => {
  const [state, setState] = useState<PetState>('idle');
  const [session, setSession] = useState<SessionState | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  sessionRef.current = session;

  // --- drag & drop -----------------------------------------------------
  const [dragCount, setDragCount] = useState(0);
  const isDragging = dragCount > 0;

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragCount((c) => c + 1);
    setState((s) => (s === 'idle' || s === 'done' || s === 'error' ? 'dragover' : s));
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Required to receive the drop, and to set the cursor to "+copy".
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragCount((c) => Math.max(0, c - 1));
  }, []);

  // Drag-enter fires on every child under the cursor; drag-leave fires
  // for each child you cross. With nested children (.pet__body /
  // .pet__mascot / <svg>) the counter can stall > 0 if Chromium omits a
  // leave event along the path, leaving the pet stuck in dragover. The
  // children already have pointer-events: none so the drop target stays
  // .pet; this timeout is the safety net for any other counter drift.
  useEffect(() => {
    if (dragCount === 0) {
      setState((s) => (s === 'dragover' ? 'idle' : s));
      return;
    }
    const t = setTimeout(() => {
      setDragCount(0);
      setState((s) => (s === 'dragover' ? 'idle' : s));
    }, 4000);
    return () => clearTimeout(t);
  }, [dragCount]);

  // --- window dragging -------------------------------------------------
  // The pet must NOT use `-webkit-app-region: drag`. Chromium routes an
  // app-region drag to the OS as a native window move, so the region never
  // receives HTML5 drag events: onDragOver can't call preventDefault(), the
  // cursor shows the "forbidden" no-drop badge, and the drop never lands.
  //
  // So we move the window ourselves. The renderer owns no geometry — it just
  // reports the pointer delta since the last move, and main accumulates that
  // onto a position captured at drag start. Accumulating on the main side
  // keeps the window from drifting (setPosition rounds to whole pixels, so
  // re-reading the rounded position each frame would compound the error).
  const movingWindow = useRef(false);
  const lastPt = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Primary button only, and never while an external drag is hovering —
      // otherwise we'd fight the user's drop.
      if (e.button !== 0 || isDragging) return;
      movingWindow.current = true;
      lastPt.current = { x: e.screenX, y: e.screenY };
      void window.todoList.pet.drag({ phase: 'start' });
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [isDragging],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!movingWindow.current) return;
    const dx = e.screenX - lastPt.current.x;
    const dy = e.screenY - lastPt.current.y;
    // Sub-pixel jitter would still cost an IPC round trip per event.
    if (dx === 0 && dy === 0) return;
    lastPt.current = { x: e.screenX, y: e.screenY };
    void window.todoList.pet.drag({ phase: 'move', dx, dy });
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!movingWindow.current) return;
    movingWindow.current = false;
    void window.todoList.pet.drag({ phase: 'end' });
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // --- submit ----------------------------------------------------------
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragCount(0);
    const dt = e.dataTransfer;
    if (!dt) {
      setState('error');
      setSession({ invocationId: '', phase: 'error', createdTitle: null, errorMsg: '未识别到拖入内容' });
      return;
    }

    // 共享 drop-payload 抽取逻辑（桌面宠物 / AI 输入框 / 备忘录三处一致）：
    //   - text/plain 优先，text/uri-list 兜底（地址栏拖链接）
    //   - 磁盘来源的文件用 webUtils.getPathForFile；web 来源（浏览器里
    //     拖出的图）退化成 data: URL
    let payload: { text: string; files: PetFileRef[] };
    try {
      payload = await readDropPayload(dt);
    } catch (err) {
      setState('error');
      setSession({ invocationId: '', phase: 'error', createdTitle: null, errorMsg: (err as Error).message });
      return;
    }
    if (!payload.text && payload.files.length === 0) {
      setState('error');
      setSession({ invocationId: '', phase: 'error', createdTitle: null, errorMsg: '请拖入文件或文本' });
      return;
    }

    const invocationId = randomId();
    setState('submitting');
    setSession({ invocationId, phase: 'submitting', createdTitle: null, errorMsg: null });

    const res = await window.todoList.pet.submit({
      invocationId,
      text: payload.text || undefined,
      files: payload.files,
    });
    if (!res.ok) {
      setState('error');
      setSession({
        invocationId,
        phase: 'error',
        createdTitle: null,
        errorMsg: res.message ?? res.code ?? '提交失败',
      });
      return;
    }
    // AIPane has the submission queued; streaming starts shortly. Flip to
    // thinking so there's immediate feedback.
    setState('thinking');
    setSession((s) => (s ? { ...s, phase: 'thinking' } : s));
  }, []);

  // --- ai:stream correlation -------------------------------------------
  useEffect(() => {
    const sid = session?.invocationId;
    if (!sid) return;
    const targetId = sid;
    const off = window.todoList.on('ai:stream', (evt) => {
      if (!('invocationId' in evt)) return;
      if ((evt as { invocationId?: string }).invocationId !== targetId) return;
      const t = (evt as { type: string }).type;
      if (t === 'done') {
        setState('done');
        setSession((s) => (s ? { ...s, phase: 'done', createdTitle: null, errorMsg: null } : s));
      } else if (t === 'error') {
        setState('error');
        setSession((s) =>
          s ? { ...s, phase: 'error', errorMsg: (evt as { error?: string }).error ?? 'AI 调用失败' } : s,
        );
      } else {
        // Any stream event means the turn is live.
        setState((s) => (s === 'thinking' ? s : 'thinking'));
      }
    });
    return off;
  }, [session?.invocationId]);

  // HITL: a question or approval landed for OUR turn.
  useEffect(() => {
    const sid = session?.invocationId;
    if (!sid) return;
    const targetId = sid;
    const offQ = window.todoList.on('ai:user-question-request', (req) => {
      if (req.invocationId !== targetId) return;
      setState('hitl-pending');
    });
    const offA = window.todoList.on('ai:user-approval-request', (req) => {
      if (req.invocationId !== targetId) return;
      setState('hitl-pending');
    });
    return () => {
      offQ();
      offA();
    };
  }, [session?.invocationId]);

  // Auto-dismiss terminal states.
  useEffect(() => {
    if (state !== 'done' && state !== 'error') return;
    const t = setTimeout(() => {
      setState('idle');
      setSession(null);
    }, state === 'done' ? DONE_DISMISS_MS : ERROR_DISMISS_MS);
    return () => clearTimeout(t);
  }, [state]);

  // --- visuals ---------------------------------------------------------
  // Shishi handles its own breathing animation and the 'receiving' state
  // visual (a card flying into the pouch) for dragover, so we don't need
  // an HTML aura overlay on top of the SVG. We only nudge the wrapper
  // scale on dragover / done so the state reads at a glance.
  const breathScale = useMemo(() => {
    if (state === 'dragover') return 1.1;
    if (state === 'done') return 1.05;
    return 1;
  }, [state]);

  const wrapperStyle = useMemo<React.CSSProperties>(
    () => ({
      transform: `scale(${breathScale})`,
      transition: 'transform 420ms cubic-bezier(.45,.05,.35,1)',
    }),
    [breathScale],
  );

  return (
    <div
      className="pet"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      data-state={state}
      style={{
        width: '100%',
        height: '100%',
        // Clip the aura's blur and any sub-pixel overflow so Chromium
        // never grows a scrollbar in this 132px window.
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // NOTE: deliberately no WebkitAppRegion here. See the drag
        // implementation above — it would kill the drop target.
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <div className="pet__body" style={wrapperStyle}>
        <div
          className="pet__mascot"
          data-state={state}
          dangerouslySetInnerHTML={{
            __html: shishiPetSvg({
              state: shishiStateFor(state),
              size: 132,
              label: '拾拾',
            }),
          }}
        />
      </div>

      <style>{`
        .pet__body, .pet__mascot, .pet__mascot svg { pointer-events: none; }
        .pet__mascot { line-height: 0; }
        .pet__mascot svg { display: block; }
      `}</style>
    </div>
  );
};

