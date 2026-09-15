// 任务优先级配色 —— 用户按优先级（none / low / medium / high）配置背景色
// 与前景色。提供多套预设 + 用户自定义命名预设，CSS 通过自定义属性
//   --task-prio-<priority>-bg / --task-prio-<priority>-fg
// 在 TodoListPane 顶层注入，.task-row[data-priority="..."] 选择器命中。
//
// 设计要点：
// - mode 只有两种：
//     theme  = 跟随主题（DEFAULT_TASK_APPEARANCE 颜色，taskListStyle 始终
//              注入该默认色的 CSS 变量，所以主题模式也有可见的优先级底色）。
//     custom = 显式配色（内建自定义预设「白底黑字 / 柔和彩色」或用户命名
//              自定义预设或手动配色），taskListStyle 把 colors 注入 CSS
//              自定义属性。
// - 持久化只存 mode + 完整 colors 映射（不存"当前选哪个预设"）。
//   "当前是否匹配某个预设"由 presetIdOf() 派生，方便任意一侧演进。
// - 用户自定义命名预设单独存为 taskAppearanceCustomPresets: [{id,label,
//   colors}]; 在 presetIdOf 里按"用户优先、内建其次"的顺序匹配颜色，让
//   用户命名预设的归属稳定。
// - 旧数据归一化：mode 缺省 / 非法 → 'theme'；colors 等于 DEFAULT_TASK_APPEARANCE
//   默认值时保留 theme；否则迁为 custom 但保留颜色，避免重置用户设置。
// - 颜色仅作 CSS 字符串接受 #RGB / #RRGGBB / 简单校验，不做语义判断（不
//   强制对比度，由用户自己选）。

import { PRIORITIES, type Priority } from './todo-types';

/** 一对前景/背景颜色。bg 用于整行底色，fg 用于标题 / pill 文字。 */
export interface TaskColorPair {
  background: string;
  foreground: string;
}

/** 4 个优先级各一对颜色。 */
export type PriorityColorMap = Record<Priority, TaskColorPair>;

/** mode 语义：theme = 应用主题（跟随主题 / 默认）；custom = 显式使用 colors，
 *  包括白底黑字 / 柔和彩色 / 深色预设 / 手动配色。 */
export type TaskAppearanceMode = 'theme' | 'custom';

export interface TaskAppearance {
  mode: TaskAppearanceMode;
  /** 完整 4 项；不在此模式下的字段也保留（用户切回 theme 时不会丢）。 */
  colors: PriorityColorMap;
}

/** 默认配色 —— 主题预设（"系统"），由 CSS 在 theme 模式下生效，不需要
 *  在 renderer 注入自定义属性。所有优先级都用项目浅色 token 的浅色版，
 *  与现有 .task-row 视觉保持一致；用户切到 custom 才接管具体颜色。
 *  5 档优先级对应 5 阶渐变：极浅灰 → 浅灰 → 浅蓝 → 浅黄 → 浅红，让优先
 *  级升档的视觉对比逐步加强。 */
export const DEFAULT_TASK_APPEARANCE: TaskAppearance = {
  mode: 'theme',
  colors: {
    'very-low': { background: '#F9FAFB', foreground: '#6B7280' },
    'low':      { background: '#F3F4F6', foreground: '#111827' },
    'medium':   { background: '#EFF6FF', foreground: '#1E3A8A' },
    'high':     { background: '#FFFBEB', foreground: '#78350F' },
    'very-high':{ background: '#FEF2F2', foreground: '#7F1D1D' },
  },
};

/** 预设 1：白底黑字 —— 全 5 档优先级统一 #FFFFFF / #000000。
 *  mode = custom：CSS 注入颜色变量，行直接上白底黑字，不再走主题默认。 */
export const PRESET_WHITE_ON_BLACK: TaskAppearance = {
  mode: 'custom',
  colors: {
    'very-low': { background: '#FFFFFF', foreground: '#000000' },
    'low':      { background: '#FFFFFF', foreground: '#000000' },
    'medium':   { background: '#FFFFFF', foreground: '#000000' },
    'high':     { background: '#FFFFFF', foreground: '#000000' },
    'very-high':{ background: '#FFFFFF', foreground: '#000000' },
  },
};

/** 预设 2：柔和彩色 —— 与 DEFAULT_TASK_APPEARANCE 相同的 5 阶渐变（极浅
 *  灰 / 浅灰 / 浅蓝 / 浅黄 / 浅红），让"跟随主题"和"柔和彩色"在视觉上一
 *  致；区别只在于 mode —— DEFAULT 走 CSS 主题规则（用户可被自己其它设置
 *  覆盖），SOFT_COLORS 强制注入具体颜色。
 *  mode = custom：CSS 注入颜色变量。 */
export const PRESET_SOFT_COLORS: TaskAppearance = {
  mode: 'custom',
  colors: {
    'very-low': { background: '#F9FAFB', foreground: '#6B7280' },
    'low':      { background: '#F3F4F6', foreground: '#111827' },
    'medium':   { background: '#EFF6FF', foreground: '#1E3A8A' },
    'high':     { background: '#FFFBEB', foreground: '#78350F' },
    'very-high':{ background: '#FEF2F2', foreground: '#7F1D1D' },
  },
};

/** 预设列表（顺序 = UI 选项顺序）。每项一个稳定 id，便于 settings 字段
 *  比较（不必每次 stringify colors）。label 用于下拉显示。
 *  跟随主题预设 value.mode === 'theme'，选中后让 CSS 主题默认规则生效；
 *  其他预设 value.mode === 'custom'，选中后 CSS 注入具体颜色。 */
export const TASK_APPEARANCE_PRESETS: { id: string; label: string; value: TaskAppearance }[] = [
  { id: 'theme',   label: '跟随主题（默认）', value: DEFAULT_TASK_APPEARANCE },
  { id: 'white',   label: '白底黑字',         value: PRESET_WHITE_ON_BLACK },
  { id: 'soft',    label: '柔和彩色',         value: PRESET_SOFT_COLORS },
];

/** 用户在设置面板里创建的命名自定义预设。id 由 crypto.randomUUID() 生成，
 *  在删除 / 重排时不复用 —— UI 顺序由 customPresets 数组顺序决定。 */
export interface TaskAppearanceCustomPreset {
  id: string;
  label: string;
  colors: PriorityColorMap;
}

/** 用户自定义预设上限。损坏的 settings.json 可能塞入大量条目；截断防止
 *  渲染时撑爆面板。32 远高于正常用量（一般 < 5）。 */
export const MAX_CUSTOM_PRESETS = 32;

/** 把任意输入归一化成有效的 TaskAppearanceCustomPreset[]。
 *  - 非数组 → []。
 *  - 每项需 id 非空字符串、label 非空字符串、5 个优先级颜色均为合法 hex；
 *    否则丢弃该条（不抛错，避免损坏文件导致面板打不开）。缺字段用
 *    DEFAULT_TASK_APPEARANCE 的对应项补齐。
 *  - 按 id 去重（首次出现胜出），保留用户命名意图。
 *  - 超过 MAX_CUSTOM_PRESETS 时截断尾部。
 *  - 不做大小写归一化、不合并同色。 */
export function normalizeCustomPresets(raw: unknown): TaskAppearanceCustomPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TaskAppearanceCustomPreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_PRESETS) break;
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<TaskAppearanceCustomPreset>;
    if (typeof obj.id !== 'string' || obj.id.length === 0) continue;
    if (seen.has(obj.id)) continue;
    if (typeof obj.label !== 'string' || obj.label.trim().length === 0) continue;
    const colors = obj.colors;
    if (!colors || typeof colors !== 'object') continue;
    const merged: PriorityColorMap = {
      'very-low': mergeColor(colors['very-low'], DEFAULT_TASK_APPEARANCE.colors['very-low']),
      'low':      mergeColor(colors.low,         DEFAULT_TASK_APPEARANCE.colors.low),
      'medium':   mergeColor(colors.medium,      DEFAULT_TASK_APPEARANCE.colors.medium),
      'high':     mergeColor(colors.high,        DEFAULT_TASK_APPEARANCE.colors.high),
      'very-high':mergeColor(colors['very-high'],DEFAULT_TASK_APPEARANCE.colors['very-high']),
    };
    seen.add(obj.id);
    out.push({ id: obj.id, label: obj.label.trim(), colors: merged });
  }
  return out;
}

/** 简单 CSS 颜色校验 —— 接受 #RGB / #RRGGBB，不接受 rgb() / 命名色。
 *  Settings UI 编辑框使用，焦点离开 / 保存时都过这一道。失败时调用方
 *  决定回退到上一个有效值或显示红框——本函数只判定合法性。 */
export function isValidCssColor(value: string): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/** 把任意输入归一化成有效的 TaskAppearance。
 *  - 非法 / 缺字段的 mode → 兼容旧 config：若 colors 等于 DEFAULT 视为
 *    'theme'，否则视为 'custom'（旧用户改过配色但 mode 字段是 theme 的
 *    情况 —— 不应重置用户的配色）。
 *  - 非法 / 缺字段的颜色项 → 用 DEFAULT_TASK_APPEARANCE 的对应项补齐。 */
export function normalizeTaskAppearance(raw: unknown): TaskAppearance {
  const base: TaskAppearance = JSON.parse(JSON.stringify(DEFAULT_TASK_APPEARANCE));
  if (raw === null || typeof raw !== 'object') return base;
  const obj = raw as Partial<TaskAppearance> & { colors?: Partial<PriorityColorMap> };
  const normalizedColors: PriorityColorMap = {
    'very-low': mergeColor(obj.colors?.['very-low'], base.colors['very-low']),
    'low':      mergeColor(obj.colors?.low,         base.colors.low),
    'medium':   mergeColor(obj.colors?.medium,      base.colors.medium),
    'high':     mergeColor(obj.colors?.high,        base.colors.high),
    'very-high':mergeColor(obj.colors?.['very-high'],base.colors['very-high']),
  };
  // 旧 config 兼容：
  //   - mode 显式 'custom'        → 'custom'（保留用户主动编辑的意图）。
  //   - mode 显式 'theme' + 颜色 = DEFAULT → 'theme'（真跟随主题）。
  //   - mode 显式 'theme' + 颜色 ≠ DEFAULT → 迁为 'custom'，保留用户的颜色
  //     （旧版本允许 theme + 自定义颜色并存，现在用 mode 区分，新规则下不应
  //     默默丢色）。
  //   - mode 字段缺失 / 非法       → 按颜色是否等于 DEFAULT 推断。
  let mode: TaskAppearanceMode;
  if (obj.mode === 'custom') {
    mode = 'custom';
  } else if (obj.mode === 'theme') {
    mode = sameColors(normalizedColors, base.colors) ? 'theme' : 'custom';
  } else {
    mode = sameColors(normalizedColors, base.colors) ? 'theme' : 'custom';
  }
  return { mode, colors: normalizedColors };
}

function mergeColor(input: Partial<TaskColorPair> | undefined, fallback: TaskColorPair): TaskColorPair {
  if (!input) return { ...fallback };
  return {
    background: typeof input.background === 'string' && isValidCssColor(input.background) ? input.background : fallback.background,
    foreground: typeof input.foreground === 'string' && isValidCssColor(input.foreground) ? input.foreground : fallback.foreground,
  };
}

/** 给定当前 appearance 与用户自定义预设列表，找到第一个匹配它的预设
 *  id；返回 'custom' 表示当前为手动配色（颜色与任何预设都不一致）。
 *  - mode='theme'  + 颜色 = DEFAULT_TASK_APPEARANCE → 'theme'（跟随主题）。
 *  - mode='custom' + 颜色匹配某个用户自定义预设 → 该用户预设 id（用户
 *    预设优先于内建，让用户命名预设的归属稳定）。
 *  - mode='custom' + 颜色匹配某个内建 custom 预设 → 该内建 id。
 *  - mode='custom' + 颜色匹配 DEFAULT 但 mode 不是 'theme' → 仍然
 *    'custom'（重要：用户显式选了 custom，只是恰好把颜色设成了默认。
 *    不能因为颜色相同就标成 theme —— 那会让下拉回弹到「跟随主题」，
 *    用户的「自定义」意图被悄悄吞掉）。注意：theme-mode 分支严格隔离，
 *    即使用户预设颜色 = DEFAULT，只要 mode='custom' 也只走下面的循环。
 *  - 任何其它情况 → 'custom'（手动配色）。 */
export function presetIdOf(
  appearance: TaskAppearance,
  customPresets: readonly TaskAppearanceCustomPreset[] = [],
): string {
  // 已归一化为 theme：颜色等于 DEFAULT 才算 theme；否则视为 custom
  // （理论上 normalizeTaskAppearance 不会让 theme+非默认色走出来，但保
  // 守起见仍按颜色判定，避免 UI 误弹「跟随主题」）。
  if (appearance.mode === 'theme') {
    return sameColors(appearance.colors, DEFAULT_TASK_APPEARANCE.colors) ? 'theme' : 'custom';
  }
  // mode === 'custom'：先匹配用户自定义预设（用户命名优先），再匹配内建
  // custom 预设。theme 预设不参与比对，避免用户把颜色调成 DEFAULT 被误标
  // 为 theme。
  for (const cp of customPresets) {
    if (sameColors(cp.colors, appearance.colors)) return cp.id;
  }
  for (const preset of TASK_APPEARANCE_PRESETS) {
    if (preset.value.mode !== 'custom') continue;
    if (sameColors(preset.value.colors, appearance.colors)) return preset.id;
  }
  // 颜色与任何预设都不一致 ——「自定义」。
  return 'custom';
}

/** 把内建预设与用户自定义预设合并为一个 UI 渲染顺序的列表（内建在前、
 *  用户在后）。返回项的形状与 TASK_APPEARANCE_PRESETS 一致，便于面板
 *  复用同一份渲染 / 应用逻辑。用户预设的 value.mode 一律为 'custom'。 */
export function getAllPresets(
  customPresets: readonly TaskAppearanceCustomPreset[] = [],
): { id: string; label: string; value: TaskAppearance; builtin: boolean }[] {
  const builtins = TASK_APPEARANCE_PRESETS.map((p) => ({ id: p.id, label: p.label, value: p.value, builtin: true }));
  const users = customPresets.map((cp) => ({
    id: cp.id,
    label: cp.label,
    value: { mode: 'custom' as const, colors: cp.colors },
    builtin: false,
  }));
  return [...builtins, ...users];
}

function sameColors(a: PriorityColorMap, b: PriorityColorMap): boolean {
  for (const p of PRIORITIES) {
    if (a[p].background.toLowerCase() !== b[p].background.toLowerCase()) return false;
    if (a[p].foreground.toLowerCase() !== b[p].foreground.toLowerCase()) return false;
  }
  return true;
}