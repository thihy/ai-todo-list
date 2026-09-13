// Tag input — chips + a (+) affordance that opens an autocomplete popover.
// No resident text field (the user rejected that); the input only appears
// transiently when adding. Tags are coloured by the registry in Settings
// (TagDef); chips fall back to a neutral colour for legacy tags not in the
// registry. Adding a new tag name also registers it (with a palette-rotated
// default colour) so the palette stays in sync without a settings round-trip.
//
// Popover layout (when draft is empty):
//   1. 最近使用 — derived from the cached todo list, sorted by updatedAt DESC.
//   2. AI 推荐   — fire-and-forget IPC (`ai.suggestTags`) on open; non-blocking,
//                  cancellable via request id; falls back silently on failure.
//   3. 全部标签  — the Settings.tags registry, filtered by draft when typed.
// When draft is non-empty, only the 全部标签 section is shown + a "新建 …"
// affordance for new tags — typed text is a filter and the contextual recs
// would only get in the way.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings, useSettingsPatchWithToast, useTodos } from '../hooks/useTodoListApi';
import { IconClose, IconPlus } from './icons';

// A preset palette for tag colours. The user picks from these — no manual
// colour picker (keeps the registry colours coherent and accessible). 12
// distinct, contrast-checked hues; new tags rotate through them by hash.
export const TAG_PALETTE = [
  '#2563eb', '#0d9488', '#9333ea', '#db2777',
  '#ca8a04', '#ea580c', '#16a34a', '#0891b2',
  '#dc2626', '#4f46e5', '#475569', '#65a30d',
];

function defaultColorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length]!;
}

/** Colour picker — a swatch button that opens a 12-colour preset palette.
 *  No manual/freeform picker; the palette is the single source of tag colours. */
export const TagColorPicker: React.FC<{
  value: string;
  onChange: (color: string) => void;
  ariaLabel?: string;
}> = ({ value, onChange, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="tag-color-picker" ref={rootRef}>
      <button
        type="button"
        className="tag-color-picker__swatch"
        style={{ background: value }}
        aria-label={ariaLabel ?? '选择颜色'}
        title="选择颜色"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="tag-color-picker__popover" role="listbox">
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c.toLowerCase() === value.toLowerCase()}
              className={`tag-color-picker__opt${c.toLowerCase() === value.toLowerCase() ? ' is-selected' : ''}`}
              style={{ background: c }}
              onClick={() => { onChange(c); setOpen(false); }}
              aria-label={c}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const TagInput: React.FC<{
  value: string[];
  onChange: (tags: string[]) => void;
  /** Optional task context. When provided, the popover's "AI 推荐" section
   *  kicks off a non-blocking tag-suggestion IPC on open. Pass `null` (or
   *  omit) to suppress the AI section entirely (e.g. when no task is loaded). */
  taskContext?: { title: string; body?: string } | null;
}> = ({ value, onChange, taskContext }) => {
  const { data } = useSettings();
  const patch = useSettingsPatchWithToast();
  // History recs derive from the cached todo list. The IPC is shared with
  // TodoListPane, so a busy workspace usually has the data already in flight
  // and the first paint of the popover is instant. If the cache is empty
  // (e.g. cold start in a task detail view), the fetch happens once on mount
  // — still local and synchronous-feeling for the user.
  const { data: allTodos } = useTodos({});
  const registry = data?.tags ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // AI section state. Kept in component state because we want a stale result
  // to overwrite cleanly when the request resolves — `useTodos` refetch is
  // irrelevant here. aiReqIdRef guards against the popover being closed
  // (or the task changing) before the response lands.
  const [aiTags, setAiTags] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const aiReqIdRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const colorOf = useCallback(
    (name: string): string => {
      const def = registry.find((t) => t.name.toLowerCase() === name.toLowerCase());
      return def?.color ?? defaultColorFor(name);
    },
    [registry],
  );

  const applied = useMemo(() => new Set(value.map((t) => t.toLowerCase())), [value]);

  // Recent tags: every (tag, updatedAt) pair across all cached todos; dedup
  // by lowercased tag name (keep latest updatedAt); sort by recency DESC;
  // cap at 6. The popover only shows this section while draft is empty and
  // filters out already-applied tags via `recentVisible`.
  const recentTags = useMemo(() => {
    const byName = new Map<string, { name: string; updatedAt: number }>();
    for (const todo of allTodos ?? []) {
      const updatedAt = todo.updatedAt ?? 0;
      for (const tag of todo.tags ?? []) {
        const trimmed = typeof tag === 'string' ? tag.trim() : '';
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        const prev = byName.get(key);
        if (!prev || updatedAt > prev.updatedAt) {
          byName.set(key, { name: trimmed, updatedAt });
        }
      }
    }
    return Array.from(byName.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((t) => t.name);
  }, [allTodos]);

  // Registry section: existing behaviour preserved verbatim — the typed text
  // is a substring filter against registry names, capped at 8.
  const registryVisible = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return registry
      .filter((t) => !applied.has(t.name.toLowerCase()))
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [registry, applied, draft]);

  const recentVisible = useMemo(
    () => recentTags.filter((name) => !applied.has(name.toLowerCase())),
    [recentTags, applied],
  );

  const aiVisible = useMemo(
    () => aiTags.filter((name) => !applied.has(name.toLowerCase())),
    [aiTags, applied],
  );

  const exactMatch = useMemo(
    () => registry.some((t) => t.name.toLowerCase() === draft.trim().toLowerCase()),
    [registry, draft],
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setDraft('');
  }, [open]);

  // Fire-and-forget AI suggestion on popover open. The request id guards
  // against the popover being closed (or the task title changing) before
  // the response lands — stale responses are dropped on the floor.
  // setTimeout(0) lets the popover paint first so the IPC doesn't block
  // the visible skeleton state.
  useEffect(() => {
    if (!open || !taskContext?.title) return;
    const reqId = ++aiReqIdRef.current;
    setAiStatus('loading');
    setAiTags([]);
    const handle = setTimeout(() => {
      // Snapshot the current value/registry so the request body reflects
      // what the user sees when the popover opened (mid-flight mutations
      // belong to a future open).
      const existingTags = [
        ...value,
        ...registry.map((r) => r.name),
      ];
      void window.todoList.ai
        .suggestTags({
          title: taskContext.title,
          body: taskContext.body,
          existingTags,
          limit: 4,
        })
        .then((res) => {
          if (reqId !== aiReqIdRef.current) return;
          if (!res.ok) {
            setAiStatus('error');
            return;
          }
          setAiTags(Array.isArray(res.data?.tags) ? res.data!.tags : []);
          setAiStatus('done');
        })
        .catch(() => {
          if (reqId !== aiReqIdRef.current) return;
          setAiStatus('error');
        });
    }, 0);
    return () => clearTimeout(handle);
  }, [open, taskContext?.title, taskContext?.body]);

  // Reset AI state on close so the next open starts fresh (skeleton, no
  // stale chips from a previous session).
  useEffect(() => {
    if (open) return;
    aiReqIdRef.current++;
    setAiStatus('idle');
    setAiTags([]);
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

  // When the user has typed text, only the registry (filtered) and the
  // "新建 …" affordance are useful — recs are by definition unfiltered and
  // would just crowd the view. The flag is shared between the two rec
  // sections so they stay in sync.
  const showRecs = draft.trim() === '';

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

          {showRecs && recentVisible.length > 0 && (
            <PopoverSection title="最近使用">
              {recentVisible.map((name) => (
                <PopoverOption
                  key={`recent-${name}`}
                  name={name}
                  color={colorOf(name)}
                  onClick={() => addTag(name)}
                />
              ))}
            </PopoverSection>
          )}

          {showRecs && taskContext && (
            <PopoverSection title="AI 推荐">
              {aiStatus === 'loading' && (
                <>
                  <PopoverSkeleton width={62} />
                  <PopoverSkeleton width={78} />
                  <PopoverSkeleton width={55} />
                </>
              )}
              {aiStatus === 'done' && aiVisible.length === 0 && (
                <div className="tag-input__empty">暂无推荐</div>
              )}
              {aiVisible.map((name) => (
                <PopoverOption
                  key={`ai-${name}`}
                  name={name}
                  color={colorOf(name)}
                  onClick={() => addTag(name)}
                />
              ))}
              {/* aiStatus === 'error' is intentionally silent — the popover
                  stays usable, and the next open will retry. */}
            </PopoverSection>
          )}

          {registryVisible.length > 0 && (
            <PopoverSection title="全部标签">
              {registryVisible.map((t) => (
                <PopoverOption
                  key={`reg-${t.name}`}
                  name={t.name}
                  color={t.color}
                  onClick={() => addTag(t.name)}
                />
              ))}
            </PopoverSection>
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

// ----- inline section helpers (kept local; TagInput is a self-contained island) -----

const PopoverSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="tag-input__section">
    <div className="tag-input__section-title">{title}</div>
    <ul className="tag-input__list" role="listbox">{children}</ul>
  </div>
);

const PopoverOption: React.FC<{ name: string; color: string; onClick: () => void }> = ({ name, color, onClick }) => (
  <li>
    <button type="button" role="option" className="tag-input__option" onClick={onClick}>
      <span className="tag-input__swatch" style={{ background: color }} />
      {name}
    </button>
  </li>
);

const PopoverSkeleton: React.FC<{ width: number }> = ({ width }) => (
  <li aria-hidden="true">
    <div className="tag-input__option tag-input__option--skeleton">
      <span className="tag-input__skeleton" style={{ width: `${width}%` }} />
    </div>
  </li>
);
