// usePrompt — a Promise-based replacement for `window.prompt`. Electron's
// BrowserWindow does not implement `window.prompt` (it always returns null),
// so any feature that needs a single text answer from the user must use this
// hook instead. Render `node` once in the component that owns the hook (it
// only mounts a dialog while a prompt is pending). `prompt(message, initial)`
// resolves with the trimmed value, or `null` if the user cancelled.

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface PromptState {
  message: string;
  initial: string;
  resolve: (value: string | null) => void;
}

export function usePrompt(): {
  prompt: (message: string, initial?: string) => Promise<string | null>;
  node: React.ReactNode;
} {
  const [state, setState] = useState<PromptState | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback(
    (message: string, initial = ''): Promise<string | null> =>
      new Promise((resolve) => {
        setDraft(initial);
        setState({ message, initial, resolve });
      }),
    [],
  );

  const close = useCallback(
    (value: string | null) => {
      if (state) state.resolve(value);
      setState(null);
    },
    [state],
  );

  // 显式 focus + select：autoFocus 在 Electron 里有时不触发（特别是 input
  // 嵌套在多层 React 树里），导致用户点 添加链接 后看不到光标；额外补一次
  // effect-based focus 让输入框总是进入可输入状态。
  useEffect(() => {
    if (state && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [state]);

  const node = state ? (
    <div className="prompt-overlay" role="dialog" aria-modal="true" onMouseDown={() => close(null)}>
      <div className="prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <label className="prompt-dialog__label">{state.message}</label>
        <input
          ref={inputRef}
          // biome-ignore lint/a11y/noAutofocus: focus the field so the user can type immediately
          autoFocus
          type="text"
          className="prompt-dialog__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(draft);
            else if (e.key === 'Escape') close(null);
          }}
        />
        <div className="prompt-dialog__actions">
          <button type="button" className="prompt-dialog__btn prompt-dialog__btn--ghost" onClick={() => close(null)}>
            取消
          </button>
          <button type="button" className="prompt-dialog__btn prompt-dialog__btn--primary" onClick={() => close(draft)}>
            确定
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { prompt, node };
}
