// 任务优先级配色面板 —— 在设置里让用户选预设（白底黑字 / 柔和彩色 / 深色
// 高对比 / 跟随主题）或切到自定义模式后逐个编辑 4 个优先级的背景色和
// 前景色。色彩由 CSS 自定义属性下发到 .task-row[data-priority="..."]。
//
// 持久化契约（与 SettingsModal 的其它面板保持一致）：
//   - 颜色调整 / 预设切换 / 自定义模式进入 —— 全部只更新本地 draft，不
//     立即落盘。预览 swatch、任务列表实时刷新都从 draft 读取。
//   - 用户点击「保存」时才把 draft 提交给父级 onSave 回调。
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
  isValidCssColor,
  normalizeTaskAppearance,
  presetIdOf,
  TASK_APPEARANCE_PRESETS,
  type PriorityColorMap,
  type TaskAppearance,
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
  /** Persist the given draft. Returns when the save round-trip is done.
   *  Throws on failure — the pane catches and turns the error into the
   *  visible `failed` state, preserving the draft so the user can retry. */
  onSave: (next: TaskAppearance) => Promise<void>;
  /** Convenience: settings-pane parent listens for this and pops a save
   *  toast. Not required. */
  onSaved?: () => void;
}

export const TaskAppearancePane: React.FC<Props> = ({ value, onSave, onSaved }) => {
  // 顶层归一化：value 缺 / null / 旧格式 / 缺某档颜色，全部走
  // `normalizeTaskAppearance` 补齐成完整的 TaskAppearance，避免后面
  // `value.mode` / `value.colors[priority]` 的连锁崩溃。
  const persisted = useMemo<TaskAppearance>(
    () => normalizeTaskAppearance(value),
    [value],
  );

  // Draft = 当前用户正在编辑的版本。初始值取自持久化的 settings；保存
  // 成功后由父级 `value` 更新触发 re-init（见 useEffect on value below）。
  const [draft, setDraft] = useState<TaskAppearance>(() => cloneAppearance(persisted));

  // 当外部持久化值变化时同步到 draft —— 仅在「没有未保存修改」时才同步，
  // 否则会冲掉用户正在敲的草稿。dirty 判定：保存状态机不在 idle 时一律
  // 视为有未保存修改。
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const isSaving = saveState.kind === 'saving';
  const isDirty = isAppearanceEqual(draft, persisted) === false;

  // 我们用 ref 跟踪「上次同步的持久值」，避免无意义的 re-init。在用户保
  // 存成功之后 value 会变化，需要重新同步；保存失败或用户编辑中则不重置。
  const lastSyncedRef = useRef<TaskAppearance>(persisted);
  useEffect(() => {
    // 失败 → 保留草稿等用户重试。
    if (saveState.kind === 'failed') return;
    // 保存中：父级 value 在 patch 成功后会被覆写，让 draft 跟上即可避
    // 免「保存后还显示旧草稿」。
    if (saveState.kind === 'saving') {
      lastSyncedRef.current = persisted;
      setDraft(cloneAppearance(persisted));
      return;
    }
    // idle + 草稿未保存 → 外部刷新绝不能覆盖用户正在敲的颜色（taskAppearance
    // 不会因其它字段被改而变化，但 monthlyCostUsd 的更新会触发同一次
    // app:settings-changed 广播 —— 这里整体走一次 settings.get，所以
    // 持久化对象引用变化不等于 taskAppearance 真的变）。我们用「draft vs
    // 当前 persisted」做 dirty 判断。
    if (!isAppearanceEqual(persisted, lastSyncedRef.current)) {
      // 仅 taskAppearance 字段本身没变时直接静默同步 lastSyncedRef；
      // 变了但草稿未保存 → 保留草稿（用户继续敲即可，保存时由 commit
      // 把当前 draft 写回，外部值会被覆盖）。这样不会让 toast「已保存」
      // 的视图突然跳回旧草稿。
      if (isAppearanceEqual(draft, persisted)) {
        lastSyncedRef.current = persisted;
        setDraft(cloneAppearance(persisted));
      } else {
        // 草稿有未保存修改 —— 仍更新 lastSyncedRef 以避免下一次外部刷新
        // 被错误地当作「变了」，但草稿不动。
        lastSyncedRef.current = persisted;
      }
    }
  }, [persisted, draft, saveState]);

  // 当前匹配到哪个预设（'theme' / 'white' / 'soft' / 'custom' / null）。
  //   - 'theme'  → 跟随主题（颜色等于 DEFAULT 且 mode=theme）；
  //   - 'white'/'soft' → 用户选了某个预设（mode=custom，颜色与预设一致）；
  //   - 'custom' → mode=custom 且颜色与任意预设都不一致（手动配色）；
  //   - null  → 旧数据兼容回退（理论上 normalizeTaskAppearance 后不会发生）。
  const selectedPreset = useMemo(() => presetIdOf(draft), [draft]);
  // 编辑区可编辑 = mode 显式为 custom。presetIdOf 返回 'custom' 同样表示
  // 用户当前在 custom 模式（手动配色）。
  const isCustom = draft.mode === 'custom';
  // 下拉「自定义」按钮高亮：selectedPreset === 'custom' 或 mode=custom 且
  // 颜色已偏离任何预设（前者已经覆盖后者，但双重判断更稳）。
  const customSelected = selectedPreset === 'custom' || isCustom;

  // 用户选了一个预设 → 更新 draft（不立即持久化）。
  const applyPreset = (presetId: string): void => {
    const preset = TASK_APPEARANCE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setDraft({
      mode: preset.value.mode,
      colors: cloneColors(preset.value.colors),
    });
  };

  // 切到 custom —— mode 翻成 custom，colors 保持当前值（用户开始调）。
  const enterCustom = (): void => {
    setDraft({
      mode: 'custom',
      colors: cloneColors(draft.colors),
    });
  };

  // 改某一个 priority 的某一通道。校验失败也接受草稿（让用户敲到一半时
  // 不被强制回弹）；保存动作统一在 commit() 里再做有效性检查。
  const updateColor = (p: Priority, channel: 'background' | 'foreground', next: string): void => {
    const trimmed = next.trim();
    const colors = cloneColors(draft.colors);
    colors[p] = { ...colors[p], [channel]: trimmed };
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
    // 如果清理后草稿等于持久值，没必要再发一次 IPC。
    if (isAppearanceEqual(sanitized, persisted)) {
      setSaveState({ kind: 'saved', at: Date.now() });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      await onSave(sanitized);
      setSaveState({ kind: 'saved', at: Date.now() });
      lastSyncedRef.current = sanitized;
      // 把清理过的版本写回 draft，避免用户继续编辑时重新触发同样的回退逻辑。
      setDraft(cloneAppearance(sanitized));
      onSaved?.();
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      setSaveState({ kind: 'failed', reason });
    }
  };

  // 撤销当前修改 —— 把 draft 复位到持久化值。
  const onDiscard = (): void => {
    setDraft(cloneAppearance(persisted));
    setSaveState({ kind: 'idle' });
  };

  return (
    <div className="settings-pane task-appearance">
      <div className="field">
        <label className="field-label">配色预设</label>
        <div className="task-appearance__presets">
          {TASK_APPEARANCE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`task-appearance__preset${selectedPreset === p.id ? ' is-selected' : ''}`}
              onClick={() => applyPreset(p.id)}
              aria-pressed={selectedPreset === p.id}
              disabled={isSaving}
            >
              {selectedPreset === p.id && (
                <span className="task-appearance__preset-check" aria-hidden="true">✓</span>
              )}
              <span className="task-appearance__preset-swatches">
                {PRIORITIES.map((prio) => (
                  <span
                    key={prio}
                    className="task-appearance__preset-swatch"
                    style={{
                      background: p.value.colors[prio].background,
                      borderColor: p.value.colors[prio].foreground,
                    }}
                    aria-hidden="true"
                  />
                ))}
              </span>
              <span className="task-appearance__preset-label">{p.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`task-appearance__preset${customSelected ? ' is-selected' : ''}`}
            onClick={enterCustom}
            aria-pressed={customSelected}
            disabled={isSaving}
          >
            {customSelected && (
              <span className="task-appearance__preset-check" aria-hidden="true">✓</span>
            )}
            <span className="task-appearance__preset-swatches">
              {PRIORITIES.map((prio) => (
                <span
                  key={prio}
                  className="task-appearance__preset-swatch"
                  style={{
                    background: draft.colors[prio].background,
                    borderColor: draft.colors[prio].foreground,
                  }}
                  aria-hidden="true"
                />
              ))}
            </span>
            <span className="task-appearance__preset-label">自定义</span>
          </button>
        </div>
        <div className="field-hint">
          {isCustom
            ? '当前为自定义模式；下方逐项调整每个优先级的背景与文字色。'
            : '选中的预设直接套用；切到「自定义」后可以单独调整每个优先级。'}
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
            ? '当前为预设模式，颜色只读；切到「自定义」后可逐项调整。'
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

/** 把一个 hex 字符串回退到 DEFAULT 的对应通道值，仅用于「保存」时清洗
 *  半成品输入；不修改用户仍在编辑的 draft 字符串。 */
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

function isAppearanceEqual(a: TaskAppearance, b: TaskAppearance): boolean {
  if (a.mode !== b.mode) return false;
  for (const p of PRIORITIES) {
    if (a.colors[p].background.toLowerCase() !== b.colors[p].background.toLowerCase()) return false;
    if (a.colors[p].foreground.toLowerCase() !== b.colors[p].foreground.toLowerCase()) return false;
  }
  return true;
}