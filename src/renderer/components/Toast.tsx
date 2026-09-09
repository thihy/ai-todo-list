// Toast bus + host. No external deps.

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
    <div
      role="region"
      aria-live="polite"
      aria-label="通知"
      style={{
        position: 'fixed',
        right: 'var(--space-md)',
        bottom: 36,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-sm)',
        zIndex: 'var(--z-toast)',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--bg-surface-elev)',
            color: kindColor(t.kind),
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 32px rgba(0,0,0,.45)',
            minWidth: 220,
            maxWidth: 360,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
          }}
        >
          <span style={{ flex: 1 }}>{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                try { t.action?.run(); } finally { dismiss(t.id); }
              }}
              style={{
                flexShrink: 0,
                padding: '2px var(--space-sm)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-strong)',
                background: 'transparent',
                color: 'var(--accent-primary)',
                fontSize: 'var(--font-xs)',
                cursor: 'pointer',
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="关闭通知"
            style={{
              flexShrink: 0,
              color: 'var(--fg-muted)',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

function kindColor(k: ToastKind): string {
  switch (k) {
    case 'info': return 'var(--fg-primary)';
    case 'success': return 'var(--accent-success)';
    case 'warn': return 'var(--accent-warn)';
    case 'error': return 'var(--accent-danger)';
  }
}