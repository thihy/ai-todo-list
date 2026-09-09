// User menu — bottom-left chip (lives in the task-list footer). Click expands a
// popup with 设置 / 关于 / 检查更新 / 退出. 设置 opens the settings modal; the
// rest go through the app.action IPC. The chip shows the OS username (no
// hardcoded preset identity); if it can't be resolved, the chip renders an
// avatar glyph only.

import React, { useEffect, useRef, useState } from 'react';

export const UserMenu: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch the OS login name once. We don't hardcode a name — the chip is the
  // current Windows user, not a preset persona.
  useEffect(() => {
    window.thihy.app.osUser().then((res) => {
      if (res.ok) setUsername(res.data.username);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const item = (label: string, onClick: () => void): React.ReactElement => (
    <button
      type="button"
      role="menuitem"
      className="user-menu__item"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  const initial = username ? username.slice(0, 1).toUpperCase() : null;

  return (
    <div className={`user-menu${open ? ' is-open' : ''}`} ref={ref}>
      <button
        type="button"
        className="user-menu__chip"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="用户菜单"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-menu__avatar" aria-hidden="true">{initial ?? '·'}</span>
        {username && <span className="user-menu__name">{username}</span>}
        <svg className="user-menu__chev" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="user-menu__popup" role="menu">
          {item('设置', onOpenSettings)}
          {item('关于', () => void window.thihy.app.action('about'))}
          {item('检查更新', () => void window.thihy.app.action('checkUpdate'))}
          <div className="user-menu__sep" aria-hidden="true" />
          {item('退出', () => void window.thihy.app.action('quit'))}
        </div>
      )}
    </div>
  );
};
