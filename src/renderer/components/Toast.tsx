// Toast bus + host. No external deps.
//
// The host renders INSIDE the task-list column (left pane) at the bottom,
// stacked upward above the footer — not as a fixed bottom-right overlay.
// See `.toast-host` in global.css for the anchoring.

import React, { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss after N ms; 0 means sticky. */
  ttl: number;
  /** Optional inline action (e.g. 恢复 on a "已删除" toast). Clicking it
   *  runs `run()` then dismisses the toast. */
  action?: ToastAction;
}

export interface ToastBus {
  push(t: Omit<Toast, 'id'>): string;
  dismiss(id: string): void;
}

export function useToastBus(): ToastBus {
  const ref = useRef<((t: Toast) => void) | null>(null);

  const bus: ToastBus = {
    push: (t) => {
      const id = crypto.randomUUID();
      ref.current?.({ id, ...t });
      return id;
    },
    dismiss: () => {
      // no-op; consumers hide via state
    },
  };

  // expose setter once mounted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus as any).__setListener = (fn: (t: Toast) => void) => {
    ref.current = fn;
  };
  return bus;
}

export const ToastHost: React.FC<{ bus: ToastBus }> = ({ bus }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bus as any).__setListener?.((t: Toast) => {
      setToasts((prev) => [...prev, t]);
      if (t.ttl > 0) {
        setTimeout(() => dismiss(t.id), t.ttl);
      }
    });
  }, [bus, dismiss]);
  return (
    <div className="toast-host" role="region" aria-live="polite" aria-label="通知">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`toast toast--${t.kind}`}>
          <span className="toast__msg">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                try { t.action?.run(); } finally { dismiss(t.id); }
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast__close" onClick={() => dismiss(t.id)} aria-label="关闭通知">
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
