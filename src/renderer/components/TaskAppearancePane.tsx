// 任务优先级配色面板 —— 在设置里让用户选预设（白底黑字 / 柔和彩色 / 深色
// 高对比 / 跟随主题）或切到自定义模式后逐个编辑 4 个优先级的背景色和
// 前景色。色彩由 CSS 自定义属性下发到 .task-row[data-priority="..."]，
// 该面板只负责把用户的选择落回 settings.taskAppearance。

import React, { useMemo, useState } from 'react';
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

interface Props {
  /** May be missing / null when an older main process returns a settings
   *  response without the field — the pane normalises to defaults before
   *  reading. Keeping the type loose here is the second layer of the
   *  boundary defence (first layer lives in `useSettings`). */
  value?: TaskAppearance | null;
  onChange: (next: TaskAppearance) => void;
}

export const TaskAppearancePane: React.FC<Props> = ({ value, onChange }) => {
  // 顶层归一化：value 缺 / null / 旧格式 / 缺某档颜色，全部走
  // `normalizeTaskAppearance` 补齐成完整的 TaskAppearance，避免后面
  // `value.mode` / `value.colors[priority]` 的连锁崩溃。
  const appearance = useMemo<TaskAppearance>(
    () => normalizeTaskAppearance(value),
    [value],
  );
  // 当前匹配到哪个预设（null = 自定义 / 没匹配的预设）。mode=custom
  // 永远 null；mode=theme 但用户改过颜色也会 null（让下拉显示"自定义"）。
  const selectedPreset = useMemo(() => presetIdOf(appearance), [appearance]);
  const isCustom = appearance.mode === 'custom';

  // 用户选了一个预设 → 把 mode 切到 'theme' 并替换 colors（同时保留
  // 用户之前在 custom 里调过的颜色，以便"切回上一份"——这里我们直接覆
  // 盖，因为 mode=custom 才意味着用户主动编辑；切到预设意味着接受预设）。
  const applyPreset = (presetId: string): void => {
    const preset = TASK_APPEARANCE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    onChange({
      mode: 'theme',
      colors: cloneColors(preset.value.colors),
    });
  };

  // 切到 custom —— mode 翻成 custom，colors 保持当前值（用户开始调）。
  const enterCustom = (): void => {
    onChange({
      mode: 'custom',
      colors: cloneColors(appearance.colors),
    });
  };

  // 改某一个 priority 的某一通道。dirty 校验失败时不持久化（保留上次
  // 有效值），但用户继续编辑其他通道不受影响。
  const updateColor = (p: Priority, channel: 'background' | 'foreground', next: string): void => {
    const trimmed = next.trim();
    // 校验失败也接受草稿（让用户敲到一半时不被强制回弹）；保存动作统一
    // 在 commit() 里再做有效性检查。
    const colors = cloneColors(appearance.colors);
    colors[p] = { ...colors[p], [channel]: trimmed };
    onChange({ mode: 'custom', colors });
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
            className={`task-appearance__preset${isCustom ? ' is-selected' : ''}`}
            onClick={enterCustom}
            aria-pressed={isCustom}
          >
            {isCustom && (
              <span className="task-appearance__preset-check" aria-hidden="true">✓</span>
            )}
            <span className="task-appearance__preset-swatches">
              {PRIORITIES.map((prio) => (
                <span
                  key={prio}
                  className="task-appearance__preset-swatch"
                  style={{
                    background: appearance.colors[prio].background,
                    borderColor: appearance.colors[prio].foreground,
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
              value={appearance.colors[p]}
              onChange={(channel, v) => updateColor(p, channel, v)}
              disabled={!isCustom}
            />
          ))}
        </div>
        <div className="field-hint">
          {!isCustom
            ? '当前为预设模式，颜色只读；切到「自定义」后可逐项调整。'
            : '颜色接受 #RGB / #RRGGBB 两种写法。修改任一项会自动保持「自定义」模式。'}
        </div>
      </div>
    </div>
  );
};

const ColorRow: React.FC<{
  priority: Priority;
  value: TaskColorPair;
  onChange: (channel: 'background' | 'foreground', next: string) => void;
  /** True when the row should be read-only — preset mode (mode !== 'custom').
   *  Inputs use `readOnly` (still selectable for copy), the color picker is
   *  fully `disabled` since it would otherwise open a native modal the user
   *  shouldn't be able to invoke. */
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

function cloneColors(c: PriorityColorMap): PriorityColorMap {
  return {
    none:   { ...c.none },
    low:    { ...c.low },
    medium: { ...c.medium },
    high:   { ...c.high },
  };
}
