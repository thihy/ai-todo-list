// Floating pet — Shishi (拾拾), a small mascot in a transparent
// always-on-top window. The character itself is rendered by the
// shishi-pet.js SVG component, which owns every motion (breathing,
// ear sway, pouch glow, sorting cards, sleeping, success rays).
//
// Drag/drop, IPC, and the surrounding state machine stay here in
// React because they have to talk to Electron. The character only
// needs to be told which mood to display.
//
// Pipeline (post memo-direct): dragover → submitting → done | error.
// pet.submit drops straight into the `memos` table (read_at = NULL
// → "未读"); no AI relay, no main-window focus. The pipeline is
// intentionally short — the pet is "随手丢", not "启动 AI"。State is
// carried by Shishi's own visuals, NOT by a text label. The whole
// 96×96 body is the drop target; the aura behind is the
// "drop here" hint and is our only decoration outside the SVG.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PetFileRef } from '../../shared/todo-list-api';
import { readDropPayload } from '../utils/drop';
import type { ShishiState } from './shishi-pet.js';
import { shishiPetSvg } from './shishi-pet.js';

type PetState = 'idle' | 'dragover' | 'submitting' | 'done' | 'error';

const DONE_DISMISS_MS = 4500;
const ERROR_DISMISS_MS = 6000;

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
    case 'idle':
    case 'error':
    default:
      // No built-in error pose. Calmed body + the data-state attrs
      // surface the error in our own inline caption.
      return 'idle';
  }
}

export const Pet = () => {
  const [state, setState] = useState<PetState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Ref to the .pet root so setPointerCapture has a stable element
  // even if React's synthetic-event currentTarget quirks ever misalign
  // (e.g. pooled events). Without a real capture target, pointermove
  // events drift to whatever's under the cursor and the drag stalls.
  const rootRef = useRef<HTMLDivElement | null>(null);

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
  // leave event along the path, leaving the pet stuck in dragover (and
  // blocking the window-drag handler). The children already have
  // pointer-events: none so the drop target stays .pet; this single
  // timer is the safety net for any other counter drift.
  //
  // The timer is held in a ref (not useEffect) so successive dragenter
  // events don't reset it — otherwise an enter/leave mismatch leaves
  // the counter pinned > 0 forever. We arm once on first enter and
  // disarm when the counter returns to 0.
  const dragOverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (dragCount === 0) {
      setState((s) => (s === 'dragover' ? 'idle' : s));
      if (dragOverTimer.current) {
        clearTimeout(dragOverTimer.current);
        dragOverTimer.current = null;
      }
      return;
    }
    if (!dragOverTimer.current) {
      dragOverTimer.current = setTimeout(() => {
        dragOverTimer.current = null;
        setDragCount(0);
        setState((s) => (s === 'dragover' ? 'idle' : s));
      }, 1500);
    }
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
      // Use the ref-backed root, not e.currentTarget — synthetic events
      // are reliable today but a stable element removes any ambiguity
      // (e.g. on edge cases where currentTarget is nullified mid-dispatch).
      rootRef.current?.setPointerCapture?.(e.pointerId);
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
    rootRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  // --- submit ----------------------------------------------------------
  // pet.submit drops straight into memos (read_at = NULL → "未读");
  // no AI relay, no main-window focus. submit/done are the same
  // captured visual; done auto-dismisses after DONE_DISMISS_MS.
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragCount(0);
    const dt = e.dataTransfer;
    if (!dt) {
      setState('error');
      setErrorMsg('未识别到拖入内容');
      return;
    }

    let payload: { text: string; files: PetFileRef[] };
    try {
      payload = await readDropPayload(dt);
    } catch (err) {
      setState('error');
      setErrorMsg((err as Error).message);
      return;
    }
    if (!payload.text && payload.files.length === 0) {
      setState('error');
      setErrorMsg('请拖入文件或文本');
      return;
    }

    setState('submitting');
    setErrorMsg(null);

    const res = await window.todoList.pet.submit({
      text: payload.text || undefined,
      files: payload.files,
    });
    if (!res.ok) {
      setState('error');
      setErrorMsg(res.message ?? res.code ?? '提交失败');
      return;
    }
    setState('done');
  }, []);

  // Auto-dismiss terminal states.
  useEffect(() => {
    if (state !== 'done' && state !== 'error') return;
    const t = setTimeout(() => {
      setState('idle');
      setErrorMsg(null);
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
      ref={rootRef}
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
        // never grows a scrollbar in this 96px window.
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
              size: 96,
              label: '拾拾',
            }),
          }}
        />
      </div>

      {/* Error caption — short, position-absolute at the bottom of the
          96px window so the SVG keeps its center stage. pointer-events
          none because the user should still be able to drag the pet from
          the caption area. pointerdown on the caption bubbles up to .pet
          (currentTarget = .pet) just fine. */}
      {state === 'error' && errorMsg ? (
        <div
          className="pet__caption"
          style={{
            position: 'absolute',
            bottom: 4,
            left: 4,
            right: 4,
            fontSize: 9,
            lineHeight: 1.15,
            color: '#b34141',
            background: 'rgba(255,255,255,0.92)',
            padding: '2px 4px',
            borderRadius: 3,
            textAlign: 'center',
            pointerEvents: 'none',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {errorMsg}
        </div>
      ) : null}

      <style>{`
        .pet__body, .pet__mascot, .pet__mascot svg { pointer-events: none; }
        .pet__mascot { line-height: 0; }
        .pet__mascot svg { display: block; }
      `}</style>
    </div>
  );
};

