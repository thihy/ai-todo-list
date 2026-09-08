// Renderer-side error boundary.

import React from 'react';

interface State {
  err: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('renderer_error', err, info);
  }

  render(): React.ReactNode {
    if (this.state.err) {
      return (
        <div
          role="alert"
          style={{
            padding: 'var(--space-xl)',
            color: 'var(--accent-danger)',
            background: 'var(--bg-canvas)',
            height: '100vh',
          }}
        >
          <h1 style={{ marginTop: 0 }}>Renderer crashed</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.err.message}</pre>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              marginTop: 'var(--space-md)',
              padding: 'var(--space-sm) var(--space-md)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--fg-primary)',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
