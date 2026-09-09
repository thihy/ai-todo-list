// Tag input — chips + a (+) affordance that opens an autocomplete popover.
// No resident text field (the user rejected that); the input only appears
// transiently when adding. Tags are coloured by the registry in Settings
// (TagDef); chips fall back to a neutral colour for legacy tags not in the
// registry. Adding a new tag name also registers it (with a palette-rotated
// default colour) so the palette stays in sync without a settings round-trip.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../hooks/useThihyApi';
import { IconClose, IconPlus } from './icons';

// A small palette for new tags whose colour the user hasn't picked yet.
// Rotated by name hash so two new tags rarely collide.
const TAG_PALETTE = [
  '#2563eb', '#0d9488', '#9333ea', '#db2777',
  '#ca8a04', '#ea580c', '#16a34a', '#0891b2',
];

function defaultColorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length]!;
}

export const TagInput: React.FC<{
  value: string[];
  onChange: (tags: string[]) => void;
}> = ({ value, onChange }) => {
  const { data, patch } = useSettings();
  const registry = data?.tags ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const colorOf = useCallback(
    (name: string): string => {
      const def = registry.find((t) => t.name.toLowerCase() === name.toLowerCase());
      return def?.color ?? defaultColorFor(name);
    },
    [registry],
  );

  // Suggestions: existing registry tags matching the typed text, excluding
  // ones already applied to this task.
  const applied = useMemo(() => new Set(value.map((t) => t.toLowerCase())), [value]);
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return registry
      .filter((t) => !applied.has(t.name.toLowerCase()))
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [registry, applied, draft]);

  const exactMatch = useMemo(
    () => registry.some((t) => t.name.toLowerCase() === draft.trim().toLowerCase()),
    [registry, draft],
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setDraft('');
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const addTag = useCallback(
    (name: string): void => {
      const tag = name.trim().replace(/^#/, '');
      if (!tag || applied.has(tag.toLowerCase())) {
        setDraft('');
        return;
      }
      onChange([...value, tag]);
      // Register the tag if it's brand new, so its colour persists and it
      // appears in Settings + future autocomplete.
      if (!registry.some((t) => t.name.toLowerCase() === tag.toLowerCase())) {
        void patch({ tags: [...registry, { name: tag, color: defaultColorFor(tag) }] });
      }
      setDraft('');
    },
    [value, onChange, applied, registry, patch],
  );

  const remove = (tag: string): void => {
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div className="tag-input" ref={rootRef}>
      {value.map((tag) => (
        <span key={tag} className="tag-input__chip" style={{ background: `color-mix(in srgb, ${colorOf(tag)} 16%, transparent)`, color: colorOf(tag) }}>
          #{tag}
          <button
            type="button"
            className="tag-input__remove"
            onClick={() => remove(tag)}
            aria-label={`移除标签 ${tag}`}
          >
            <IconClose size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="tag-input__add" onClick={() => setOpen((v) => !v)} aria-label="添加标签">
        <IconPlus size={14} />
      </button>

      {open && (
        <div className="tag-input__popover">
          <input
            ref={inputRef}
            type="text"
            className="tag-input__field"
            placeholder="搜索或新建标签…"
            aria-label="标签名称"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft.trim()) addTag(draft);
              }
            }}
          />
          {suggestions.length > 0 && (
            <ul className="tag-input__list" role="listbox">
              {suggestions.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    role="option"
                    className="tag-input__option"
                    onClick={() => addTag(t.name)}
                  >
                    <span className="tag-input__swatch" style={{ background: t.color }} />
                    {t.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draft.trim() && !exactMatch && !applied.has(draft.trim().toLowerCase()) && (
            <button
              type="button"
              className="tag-input__option tag-input__option--new"
              onClick={() => addTag(draft)}
            >
              <span className="tag-input__swatch" style={{ background: defaultColorFor(draft.trim()) }} />
              新建「{draft.trim()}」
            </button>
          )}
        </div>
      )}
    </div>
  );
};
