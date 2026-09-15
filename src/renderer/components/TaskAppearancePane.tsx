// 任务优先级配色面板 —— 在设置里让用户选预设（白底黑字 / 柔和彩色 / 跟随
// 主题），或创建 / 选择 / 删除「命名自定义预设」（持久化、可重选），或
// 切到通用自定义模式后逐个编辑 4 个优先级的背景色和前景色。色彩由 CSS
// 自定义属性下发到 .task-row[data-priority="..."]。
//
// 持久化契约（与 SettingsModal 的其它面板保持一致）：
//   - 颜色调整 / 预设切换 / 新建命名预设 / 删除命名预设 —— 全部只更新
//     本地 draft 与 customPresets，不立即落盘。预览 swatch、任务列表实
//     时刷新都从 draft 读取。
//   - 用户点击「保存」时才把 draft + customPresets 一起提交给父级
//     onSave。如果当前选中的正是某个命名自定义预设（即 presetIdOf 命
//     中 customPresets 中的某项 id），则把该项的 colors 替换为草稿的
//     colors —— 隐式回写：用户选中「我的深色」后改了一项颜色点保存，
//     预设一并更新。
//   - 保存期间显示「保存中」并禁用重复提交；成功显示「已保存」；失败显
//     示「保存失败：原因」，草稿保留，允许重试。
//   - 外部 app:settings-changed 刷新（AI 月度成本写入等会触发）只有当
//     当前没有未保存草稿时才同步到 draft。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PRIORITIES,
  type Priority,
} from '../../shared/todo-types';
import {
  DEFAULT_TASK_APPEARANCE,
  TASK_APPEARANCE_PRESETS,
  getAllPresets,
  isValidCssColor,
  normalizeTaskAppearance,
  presetIdOf,
  type PriorityColorMap,
  type TaskAppearance,
  type TaskAppearanceCustomPreset,
  type TaskColorPair,
} from '../../shared/task-appearance';

const PRIORITY_LABEL: Record<Priority, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
};

/** Save state machine — drives the status row + button enable/disable. */
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'failed'; reason: string };

interface Props {
  /** May be missing / null when an older main process returns a settings
   *  response without the field — the pane normalises to defaults before
   *  reading. Keeping the type loose here is the second layer of the
   *  boundary defence (first layer lives in `useSettings`). */
  value?: TaskAppearance | null;
  /** 用户在设置面板里创建的命名自定义预设。同样的归一化兜底 —— 跨版本
   *  主进程可能没下发，第二个参数走默认 []。 */
  customPresets?: TaskAppearanceCustomPreset[];
  /** Persist the given draft + customPresets. Returns when the save
   *  round-trip is done. Throws on failure — the pane catches and turns
   *  the error into the visible `failed` state, preserving the draft so
   *  the user can retry. */
  onSave: (
    next: TaskAppearance,
    nextCustomPresets: TaskAppearanceCustomPreset[],
  ) => Promise<void>;
  /** Convenience: settings-pane parent listens for this and pops a save
   *  toast. Not required. */
  onSaved?: () => void;
}

export const TaskAppearancePane: React.FC<Props> = ({
  value,
  customPresets,
  onSave,
  onSaved,
}) => {
  // 顶层归一化：value 缺 / null / 旧格式 / 缺某档颜色，全部走
  // `normalizeTaskAppearance` 补齐成完整的 TaskAppearance，避免后面
  // `value.mode` / `value.colors[priority]` 的连锁崩溃。
  const persisted = useMemo<TaskAppearance>(
    () => normalizeTaskAppearance(value),
    [value],
  );
  // customPresets 也走 normalizeCustomPresets 兜底 —— 跨版本主进程可能
  // 没下发这个字段，Settings 那一层已经归一化过，这里再做一遍以防
  // SettingsModal 直接传入 raw 数组。
  const persistedCustomPresets = useMemo<TaskAppearanceCustomPreset[]>(
    () => customPresets ?? [],
    [customPresets],
  );

  // Draft = 当前用户正在编辑的版本。初始值取自持久化的 settings；保存
  // 成功后由父级 `value` 更新触发 re-init（见 useEffect on value below）。
  const [draft, setDraft] = useState<TaskAppearance>(() => cloneAppearance(persisted));
  // 用户自定义预设的本地草稿 —— 新建 / 删除 / 隐式回写都在这里发生，
  // 最终在保存时一次性提交。
  const [draftCustomPresets, setDraftCustomPresets] = useState<TaskAppearanceCustomPreset[]>(
    () => cloneCustomPresets(persistedCustomPresets),
  );
  // 「+ 新增自定义」按钮点击后展开的行内输入框。null = 未展开；string =
  // 当前输入文本。Enter 确认 / Escape 取消 / 失焦且空 → 取消。
  const [creatingName, setCreatingName] = useState<string | null>(null);

  // 当外部持久化值变化时同步到 draft —— 仅在「没有未保存修改」时才同步，
  // 否则会冲掉用户正在敲的草稿。dirty 判定：保存状态机不在 idle 时一律
  // 视为有未保存修改。
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const isSaving = saveState.kind === 'saving';
  const appearanceDirty = !isAppearanceEqual(draft, persisted);
  const customPresetsDirty = !sameCustomPresetLists(
    draftCustomPresets,
    persistedCustomPresets,
  );
  const isDirty = appearanceDirty || customPresetsDirty;

  // 我们用 ref 跟踪「上次同步的持久值」，避免无意义的 re-init。在用户保
  // 存成功之后 value 会变化，需要重新同步；保存失败或用户编辑中则不重置。
  const lastSyncedRef = useRef<{
    appearance: TaskAppearance;
    customPresets: TaskAppearanceCustomPreset[];
  }>({
    appearance: persisted,
    customPresets: persistedCustomPresets,
  });
  useEffect(() => {
    // 失败 → 保留草稿等用户重试。
    if (saveState.kind === 'failed') return;
    // 保存中：父级 value 在 patch 成功后会被覆写，让 draft 跟上即可避
    // 免「保存后还显示旧草稿」。
    if (saveState.kind === 'saving') {
      lastSyncedRef.current = {
        appearance: persisted,
        customPresets: persistedCustomPresets,
      };
      setDraft(cloneAppearance(persisted));
      setDraftCustomPresets(cloneCustomPresets(persistedCustomPresets));
      return;
    }
    // idle + 外部刷新：只有 taskAppearance 或 customPresets 真的变了才
    // 走更深一层的判断 —— monthlyCostUsd 的更新也会触发同一次
    // app:settings-changed 广播，settings.get 整体返回引用会变。
    const appearanceChanged = !isAppearanceEqual(
      persisted,
      lastSyncedRef.current.appearance,
    );
    const presetsChanged = !sameCustomPresetLists(
      persistedCustomPresets,
      lastSyncedRef.current.customPresets,
    );
    if (!appearanceChanged && !presetsChanged) return;
    // 变了但草稿未保存 → 保留草稿（用户继续敲即可，保存时由 commit
    // 把当前 draft 写回，外部值会被覆盖）。仍更新 lastSyncedRef 以避
    // 免下一次外部刷新被错误地当作「变了」。
    const draftSync = isAppearanceEqual(draft, persisted);
    const presetsSync = sameCustomPresetLists(
      draftCustomPresets,
      persistedCustomPresets,
    );
    lastSyncedRef.current = {
      appearance: persisted,
      customPresets: persistedCustomPresets,
    };
    if (draftSync && presetsSync) {
      setDraft(cloneAppearance(persisted));
      setDraftCustomPresets(cloneCustomPresets(persistedCustomPresets));
    }
  }, [persisted, persistedCustomPresets, draft, draftCustomPresets, saveState]);

  // 当前匹配到哪个预设（'theme' / 内建 id / 用户自定义 id / 'custom'）。
  //   - 'theme'  → 跟随主题（颜色等于 DEFAULT 且 mode=theme）；
  //   - 内建 id（'white' / 'soft'）→ 用户选了某个内建预设；
  //   - 用户自定义 id → 用户选了某个命名预设；
  //   - 'custom' → mode=custom 且颜色与任意预设都不一致（手动配色）。
  //
  // explicitPresetId：用户最近一次明确点击的预设 id。优先级高于颜色匹
  // 配 —— 多个用户自定义预设恰好颜色相同时（典型场景：刚创建的两个预
  // 设都用 DEFAULT 颜色），如果不显式追踪 id，presetIdOf 会按列表顺序
  // 匹配到第一个预设，导致"只能选中第一个自定义配色"的 bug。Initial
  // null → 走 presetIdOf 派生；组件挂载时也走派生（persisted 已经决定
  // 了应该高亮哪个）。
  const [explicitPresetId, setExplicitPresetId] = useState<string | null>(null);
  const allPresets = useMemo(
    () => getAllPresets(draftCustomPresets),
    [draftCustomPresets],
  );
  const selectedPreset = useMemo(() => {
    if (explicitPresetId !== null && allPresets.some((p) => p.id === explicitPresetId)) {
      return explicitPresetId;
    }
    return presetIdOf(draft, draftCustomPresets);
  }, [explicitPresetId, allPresets, draft, draftCustomPresets]);
  // 编辑区可编辑 = mode 显式为 custom。presetIdOf 返回 'custom' 同样表
  // 示用户当前在 custom 模式（手动配色）。Bug 2 修复：原版本另起一行
  // 「自定义」按钮 + `customSelected = selectedPreset === 'custom' ||
  // isCustom`，导致「白底黑字」「柔和彩色」「命名自定义」都被错误高
  // 亮「自定义」。新版本不再单设「自定义」入口：选「白底黑字」就只
  // 亮「白底黑字」那一行；想手动配色直接改色板（updateColor 会把
  // mode 翻成 custom），下拉也不会突然跳到一格不存在的「自定义」。
  const isCustom = draft.mode === 'custom';

  // 用户选了一个预设 → 更新 draft（不立即持久化）。内建与用户自定义预设
  // 都走这里；用户预设直接取其 colors 作为 draft 起点。
  const applyPreset = (presetId: string): void => {
    const preset = allPresets.find((p) => p.id === presetId);
    if (!preset) return;
    setDraft({
      mode: preset.value.mode,
      colors: cloneColors(preset.value.colors),
    });
    // 显式锚定该预设 id：UI 高亮走 explicitPresetId 优先，而不是按颜色
    // 重新匹配（见 selectedPreset useMemo）。这样多个同色预设也能各自
    // 正确高亮。
    setExplicitPresetId(presetId);
    // 切到「跟随主题」时收起正在进行的「新增自定义」输入框，避免脏态
    // 跟预设选择混在一起导致保存时发出一份半成品请求。
    if (preset.value.mode === 'theme') setCreatingName(null);
  };

  // 新建命名自定义预设 —— 展开行内 <input>。
  const beginCreate = (): void => {
    setCreatingName('');
  };
  const cancelCreate = (): void => {
    setCreatingName(null);
  };
  const confirmCreate = (): void => {
    const name = (creatingName ?? '').trim();
    if (!name) {
      cancelCreate();
      return;
    }
    const id = crypto.randomUUID();
    const next: TaskAppearanceCustomPreset = {
      id,
      label: name,
      colors: cloneColors(DEFAULT_TASK_APPEARANCE.colors),
    };
    setDraftCustomPresets((prev) => [...prev, next]);
    setDraft({ mode: 'custom', colors: cloneColors(next.colors) });
    // 新建的预设默认被选中 —— explicitPresetId 直接指向它，无需走颜色
    // 匹配（虽然颜色 = DEFAULT 也能匹配到自己，但显式更稳）。
    setExplicitPresetId(id);
    setCreatingName(null);
  };

  // 删除一个用户自定义预设。二次确认（window.confirm）。如果该项被选中
  // ，把 draft 复位到「跟随主题」。
  const removeCustomPreset = (id: string): void => {
    const target = draftCustomPresets.find((p) => p.id === id);
    if (!target) return;
    const ok = window.confirm(`确定删除自定义预设「${target.label}」？`);
    if (!ok) return;
    setDraftCustomPresets((prev) => prev.filter((p) => p.id !== id));
    if (explicitPresetId === id) {
      // 删除的恰好是当前显式选中的预设：draft 复位到「跟随主题」，
      // explicitPresetId 清空让 UI 走 presetIdOf 派生。
      setDraft(cloneAppearance(DEFAULT_TASK_APPEARANCE));
      setExplicitPresetId(null);
    }
  };

  // 改某一个 priority 的某一通道。校验失败也接受草稿（让用户敲到一半时
  // 不被强制回弹）；保存动作统一在 commit() 里再做有效性检查。
  const updateColor = (p: Priority, channel: 'background' | 'foreground', next: string): void => {
    const trimmed = next.trim();
    const colors = cloneColors(draft.colors);
    colors[p] = { ...colors[p], [channel]: trimmed };
    // 用户手动改色 → 切到 custom 模式。如果之前显式选的是内建预设
    // （theme / white / soft），清掉 explicitPresetId —— 内建预设不会
    // 随用户编辑更新，保留 explicitPresetId 会让 UI 高亮一个跟实际颜色
    // 不一致的预设。用户自定义预设保留 explicitPresetId，让保存时
    // 把改动隐式回写到该预设（这就是"+ 新增自定义"的核心 UX）。
    setExplicitPresetId((prev) => {
      if (prev === null) return null;
      if (TASK_APPEARANCE_PRESETS.some((bp) => bp.id === prev)) return null;
      return prev;
    });
    setDraft({ mode: 'custom', colors });
  };

  // 提交草稿 → 调父级 onSave 异步保存。保存期间阻止重复提交，失败保留草稿。
  const onSubmit = async (): Promise<void> => {
    if (isSaving) return;
    // 在保存前把任何「半成品 hex」（例如正在敲 #FF 但还没敲完）回退到上次
    // 合法值，避免 settings.taskAppearance 被无效字符串污染。
    const sanitized: TaskAppearance = {
      mode: draft.mode,
      colors: {
        none:   sanitizePair(draft.colors.none),
        low:    sanitizePair(draft.colors.low),
        medium: sanitizePair(draft.colors.medium),
        high:   sanitizePair(draft.colors.high),
      },
    };
    // 「命中用户自定义预设」时把该预设的 colors 同步成当前草稿 —— 隐式
    // 回写：用户选中「我的深色」后改了一项颜色点保存，预设一并更新。
    // explicitPresetId 优先：用户显式选中的预设即使 draft.colors 已经偏
    // 离原色，也照样写回（前提是该预设仍在 customPresets 中）。
    let nextCustomPresets = draftCustomPresets;
    const matchedId = explicitPresetId ?? presetIdOf(sanitized, draftCustomPresets);
    const matchedIdx = draftCustomPresets.findIndex((p) => p.id === matchedId);
    if (matchedIdx >= 0) {
      nextCustomPresets = draftCustomPresets.map((p, i) =>
        i === matchedIdx ? { ...p, colors: cloneColors(sanitized.colors) } : p,
      );
    }
    // 如果清理后 appearance + customPresets 都等于持久值，没必要再发一次 IPC。
    if (
      isAppearanceEqual(sanitized, persisted) &&
      sameCustomPresetLists(nextCustomPresets, persistedCustomPresets)
    ) {
      setSaveState({ kind: 'saved', at: Date.now() });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      await onSave(sanitized, nextCustomPresets);
      setSaveState({ kind: 'saved', at: Date.now() });
      lastSyncedRef.current = {
        appearance: sanitized,
        customPresets: nextCustomPresets,
      };
      // 把清理过的版本写回 draft，避免用户继续编辑时重新触发同样的回退逻辑。
      setDraft(cloneAppearance(sanitized));
      setDraftCustomPresets(cloneCustomPresets(nextCustomPresets));
      onSaved?.();
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      setSaveState({ kind: 'failed', reason });
    }
  };

  // 撤销当前修改 —— 把 draft 复位到持久化值。
  const onDiscard = (): void => {
    setDraft(cloneAppearance(persisted));
    setDraftCustomPresets(cloneCustomPresets(persistedCustomPresets));
    setCreatingName(null);
    setExplicitPresetId(null);
    setSaveState({ kind: 'idle' });
  };

  return (
    <div className="settings-pane task-appearance">
      <div className="field">
        <label className="field-label">配色预设</label>
        <div className="task-appearance__presets">
          {allPresets.map((p) => (
            <PresetButton
              key={p.id}
              preset={p}
              selected={selectedPreset === p.id}
              onSelect={() => applyPreset(p.id)}
              onDelete={p.builtin ? undefined : () => removeCustomPreset(p.id)}
              disabled={isSaving}
            />
          ))}
          {creatingName !== null ? (
            <NewPresetInput
              value={creatingName}
              onChange={setCreatingName}
              onConfirm={confirmCreate}
              onCancel={cancelCreate}
              disabled={isSaving}
            />
          ) : (
            <button
              type="button"
              className="task-appearance__preset task-appearance__preset--add"
              onClick={beginCreate}
              disabled={isSaving}
            >
              <span className="task-appearance__preset-label">＋ 新增自定义</span>
            </button>
          )}
        </div>
        <div className="field-hint">
          {selectedPreset === 'theme'
            ? '当前为「跟随主题」，行底色与标题色由 DEFAULT 调色板决定；hover / active 走应用默认主题样式。'
            : isCustom
              ? '当前为自定义模式；下方逐项调整每个优先级的背景与文字色。'
              : '选中的预设直接套用；保存时若仍在该预设上，颜色会一并写入预设。'}
        </div>
      </div>

      <div className="field">
        <label className="field-label">按优先级编辑</label>
        <div className="task-appearance__editor" aria-disabled={!isCustom}>
          {PRIORITIES.map((p) => (
            <ColorRow
              key={p}
              priority={p}
              value={draft.colors[p]}
              onChange={(channel, v) => updateColor(p, channel, v)}
              disabled={!isCustom || isSaving}
            />
          ))}
        </div>
        <div className="field-hint">
          {!isCustom
            ? '当前为预设模式，颜色只读；选中命名自定义预设或「+ 新增自定义」后可逐项调整。'
            : '颜色接受 #RGB / #RRGGBB 两种写法。预览实时刷新；点「保存」后才会写入磁盘。'}
        </div>
      </div>

      {/* 保存状态行 + 操作按钮：失败时强提示，草稿保留。 */}
      <div className={`task-appearance__save-row${saveState.kind === 'failed' ? ' is-error' : ''}`}>
        <span className="task-appearance__save-status" role="status" aria-live="polite">
          {saveState.kind === 'saving' && '保存中…'}
          {saveState.kind === 'saved' && '已保存'}
          {saveState.kind === 'failed' && `保存失败：${saveState.reason}`}
          {saveState.kind === 'idle' && (isDirty ? '有未保存修改' : '已同步最新设置')}
        </span>
        <button
          type="button"
          className="btn-ghost"
          onClick={onDiscard}
          disabled={isSaving || !isDirty}
        >
          撤销
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void onSubmit()}
          disabled={isSaving || !isDirty}
        >
          {saveState.kind === 'saving' ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
};

const PresetButton: React.FC<{
  preset: { id: string; label: string; value: TaskAppearance; builtin: boolean };
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  disabled: boolean;
}> = ({ preset, selected, onSelect, onDelete, disabled }) => {
  // 鼠标 hover 时显示 × 删除按钮（仅用户自定义预设）。CSS 也会有同
  // 样的 hover 处理，React hover 仅用于避免 disabled 时残留 ×。
  const [hover, setHover] = useState(false);
  const showDelete = Boolean(onDelete) && hover && !disabled;
  return (
    <button
      type="button"
      className={`task-appearance__preset${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-pressed={selected}
      disabled={disabled}
    >
      {selected && (
        <span className="task-appearance__preset-check" aria-hidden="true">✓</span>
      )}
      <span className="task-appearance__preset-swatches">
        {PRIORITIES.map((prio) => (
          <span
            key={prio}
            className="task-appearance__preset-swatch"
            style={{
              background: preset.value.colors[prio].background,
              borderColor: preset.value.colors[prio].foreground,
            }}
            aria-hidden="true"
          />
        ))}
      </span>
      <span className="task-appearance__preset-label">{preset.label}</span>
      {onDelete && (
        <span
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={`删除预设 ${preset.label}`}
          className={`task-appearance__preset-delete${showDelete ? ' is-visible' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            onDelete();
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3L9 9 M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
      )}
    </button>
  );
};

const NewPresetInput: React.FC<{
  value: string;
  onChange: (next: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}> = ({ value, onChange, onConfirm, onCancel, disabled }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 自动 focus。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="task-appearance__preset task-appearance__preset--creating">
      <input
        ref={inputRef}
        type="text"
        className="input task-appearance__new-name"
        placeholder="预设名称"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          // 失焦且空字符串 → 取消；非空保留（用户用 Enter / Escape 显式决定
          // ，或点「创建」按钮，onMouseDown preventDefault 阻止此处先
          // 触发 blur）。
          if (!value.trim()) onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onConfirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        disabled={disabled}
        aria-label="新建自定义预设名称"
        maxLength={40}
      />
      <button
        type="button"
        className="btn-secondary task-appearance__new-confirm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onConfirm}
        disabled={disabled || !value.trim()}
      >
        创建
      </button>
    </div>
  );
};

const ColorRow: React.FC<{
  priority: Priority;
  value: TaskColorPair;
  onChange: (channel: 'background' | 'foreground', next: string) => void;
  /** True when the row should be read-only — preset mode (mode !== 'custom')
   *  or during a save round-trip. Inputs use `readOnly` (still selectable
   *  for copy), the color picker is fully `disabled` since it would
   *  otherwise open a native modal the user shouldn't be able to invoke. */
  disabled?: boolean;
}> = ({ priority, value, onChange, disabled = false }) => {
  const [bg, setBg] = useState(value.background);
  const [fg, setFg] = useState(value.foreground);
  // 当外部 value 变化（切预设等）同步本地 draft，避免用户敲到一半被外部
  // 重置冲掉。
  React.useEffect(() => { setBg(value.background); }, [value.background]);
  React.useEffect(() => { setFg(value.foreground); }, [value.foreground]);

  const bgInvalid = bg.length > 0 && !isValidCssColor(bg);
  const fgInvalid = fg.length > 0 && !isValidCssColor(fg);

  // commit on blur：只有合法值才下发到外层，避免半成品 # 写到 settings。
  const commitBg = (): void => {
    if (disabled) return;
    if (isValidCssColor(bg)) onChange('background', bg);
    else setBg(value.background);
  };
  const commitFg = (): void => {
    if (disabled) return;
    if (isValidCssColor(fg)) onChange('foreground', fg);
    else setFg(value.foreground);
  };

  // 系统色板：<input type="color"> 在 Electron 里打开系统原生颜色选择器。
  // 它永远吐出合法的 #RRGGBB,所以拾取动作直接同步到本地 draft + 立刻
  // commit onChange,任务列表会跟着实时刷新,不用等 blur。色板本身就是
  // 一个 28×28 的视觉色块,所以旁边不再单独放预览 swatch —— 避免 hex
  // 输入、色板、swatch 三个颜色元件挤一行。
  const pickBg = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (disabled) return;
    const picked = e.target.value.toUpperCase();
    setBg(picked);
    onChange('background', picked);
  };
  const pickFg = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (disabled) return;
    const picked = e.target.value.toUpperCase();
    setFg(picked);
    onChange('foreground', picked);
  };
  // 色板的 `value` 必须始终是合法 hex;无效草稿期间(用户正在敲一半)用
  // 上一次有效值兜底,否则色板会因非法 value 直接抛错。
  const bgPickerValue = isValidCssColor(bg) ? bg : value.background;
  const fgPickerValue = isValidCssColor(fg) ? fg : value.foreground;

  return (
    <div className={`task-appearance__row${disabled ? ' is-disabled' : ''}`}>
      <div className="task-appearance__row-label">{PRIORITY_LABEL[priority]}</div>
      <label className="task-appearance__field">
        <span className="task-appearance__field-label">背景</span>
        <input
          type="text"
          className={`input mono task-appearance__color-input${bgInvalid ? ' is-error' : ''}`}
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          onBlur={commitBg}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label={`${PRIORITY_LABEL[priority]} 优先级 背景色`}
          placeholder="#RRGGBB"
          spellCheck={false}
          readOnly={disabled}
          aria-readonly={disabled}
        />
        <input
          type="color"
          className="task-appearance__picker"
          value={bgPickerValue}
          onChange={pickBg}
          aria-label={`${PRIORITY_LABEL[priority]} 优先级 背景色 色板`}
          title="从色板选择颜色"
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
        />
      </label>
      <label className="task-appearance__field">
        <span className="task-appearance__field-label">文字</span>
        <input
          type="text"
          className={`input mono task-appearance__color-input${fgInvalid ? ' is-error' : ''}`}
          value={fg}
          onChange={(e) => setFg(e.target.value)}
          onBlur={commitFg}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label={`${PRIORITY_LABEL[priority]} 优先级 文字色`}
          placeholder="#RRGGBB"
          spellCheck={false}
          readOnly={disabled}
          aria-readonly={disabled}
        />
        <input
          type="color"
          className="task-appearance__picker"
          value={fgPickerValue}
          onChange={pickFg}
          aria-label={`${PRIORITY_LABEL[priority]} 优先级 文字色 色板`}
          title="从色板选择颜色"
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
        />
      </label>
    </div>
  );
};

/** 把一个 hex 字符串回退到上一个有效值，仅用于「保存」时清洗半成品
 *  输入；不修改用户仍在编辑的 draft 字符串。 */
function sanitizePair(p: TaskColorPair): TaskColorPair {
  return {
    background: isValidCssColor(p.background) ? p.background : '#FFFFFF',
    foreground: isValidCssColor(p.foreground) ? p.foreground : '#000000',
  };
}

function cloneColors(c: PriorityColorMap): PriorityColorMap {
  return {
    none:   { ...c.none },
    low:    { ...c.low },
    medium: { ...c.medium },
    high:   { ...c.high },
  };
}

function cloneAppearance(a: TaskAppearance): TaskAppearance {
  return { mode: a.mode, colors: cloneColors(a.colors) };
}

function cloneCustomPresets(
  list: readonly TaskAppearanceCustomPreset[],
): TaskAppearanceCustomPreset[] {
  return list.map((p) => ({ id: p.id, label: p.label, colors: cloneColors(p.colors) }));
}

function isAppearanceEqual(a: TaskAppearance, b: TaskAppearance): boolean {
  if (a.mode !== b.mode) return false;
  for (const p of PRIORITIES) {
    if (a.colors[p].background.toLowerCase() !== b.colors[p].background.toLowerCase()) return false;
    if (a.colors[p].foreground.toLowerCase() !== b.colors[p].foreground.toLowerCase()) return false;
  }
  return true;
}

function sameCustomPresetLists(
  a: readonly TaskAppearanceCustomPreset[],
  b: readonly TaskAppearanceCustomPreset[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].label !== b[i].label) return false;
    if (!isAppearanceEqual(
      { mode: 'custom', colors: a[i].colors },
      { mode: 'custom', colors: b[i].colors },
    )) return false;
  }
  return true;
}