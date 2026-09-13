// 任务优先级配色 —— 用户按优先级（none / low / medium / high）配置背景色
// 与前景色。提供多套预设 + 自定义模式，CSS 通过自定义属性
//   --task-prio-<priority>-bg / --task-prio-<priority>-fg
// 在 TodoListPane 顶层注入，.task-row[data-priority="..."] 选择器命中。
//
// 设计要点：
// - 持久化只存 mode + 完整 colors 映射（不存"当前选哪个预设"）。
//   "当前是否匹配某个预设"由 compareToPreset() 派生，方便任意一侧演进。
// - 旧数据归一化：mode 缺省 / 非法 → 'theme'；任一 priority 缺字段 → 用
//   DEFAULT_TASK_APPEARANCE 的对应项补齐。保证不会因为 SettingsJson 损坏
//   导致任务列表的 CSS 变量失败而显示空白。
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

/** 模式：theme = 跟随预设（不可自定义）；custom = 自定义颜色。 */
export type TaskAppearanceMode = 'theme' | 'custom';

export interface TaskAppearance {
  mode: TaskAppearanceMode;
  /** 完整 4 项；不在此模式下的字段也保留（用户切回 theme 时不会丢）。 */
  colors: PriorityColorMap;
}

/** 默认配色 —— 主题预设（"系统"），由 CSS 在 theme 模式下生效，不需要
 *  在 renderer 注入自定义属性。所有优先级都用项目浅色 token 的浅色版，
 *  与现有 .task-row 视觉保持一致；用户切到 custom 才接管具体颜色。 */
export const DEFAULT_TASK_APPEARANCE: TaskAppearance = {
  mode: 'theme',
  colors: {
    none:    { background: '#FFFFFF', foreground: '#1F2329' },
    low:     { background: '#F3F4F6', foreground: '#111827' },
    medium:  { background: '#EFF6FF', foreground: '#1E3A8A' },
    high:    { background: '#FFFBEB', foreground: '#78350F' },
  },
};

/** 预设 1：白底黑字 —— 全优先级统一 #FFFFFF / #000000。 */
export const PRESET_WHITE_ON_BLACK: TaskAppearance = {
  mode: 'theme',
  colors: {
    none:   { background: '#FFFFFF', foreground: '#000000' },
    low:    { background: '#FFFFFF', foreground: '#000000' },
    medium: { background: '#FFFFFF', foreground: '#000000' },
    high:   { background: '#FFFFFF', foreground: '#000000' },
  },
};

/** 预设 2：柔和彩色 —— 4 个优先级分别淡色 bg + 深色 fg，对应 task-row
 *  历史默认行为（none 接近白底 / low 浅灰 / medium 浅蓝 / high 浅橙黄）。 */
export const PRESET_SOFT_COLORS: TaskAppearance = {
  mode: 'theme',
  colors: {
    none:   { background: '#F3F4F6', foreground: '#111827' },
    low:    { background: '#EFF6FF', foreground: '#1E3A8A' },
    medium: { background: '#FFFBEB', foreground: '#78350F' },
    high:   { background: '#FEF2F2', foreground: '#7F1D1D' },
  },
};

/** 预设列表（顺序 = UI 选项顺序）。每项一个稳定 id，便于 settings 字段
 *  比较（不必每次 stringify colors）。label 用于下拉显示。
 *  「深色高对比」预设已下线：深 bg + 亮 fg 在浅色主题下读起来对比过强，
 *  用户反馈效果差，UI 直接砍掉。历史用户的 settings.colors 若碰巧等于
 *  旧预设值，presetIdOf 会返回 null，下拉自然落到「自定义」——无数据
 *  迁移负担。 */
export const TASK_APPEARANCE_PRESETS: { id: string; label: string; value: TaskAppearance }[] = [
  { id: 'theme',   label: '跟随主题（默认）', value: DEFAULT_TASK_APPEARANCE },
  { id: 'white',   label: '白底黑字',         value: PRESET_WHITE_ON_BLACK },
  { id: 'soft',    label: '柔和彩色',         value: PRESET_SOFT_COLORS },
];

/** 简单 CSS 颜色校验 —— 接受 #RGB / #RRGGBB，不接受 rgb() / 命名色。
 *  Settings UI 编辑框使用，焦点离开 / 保存时都过这一道。失败时调用方
 *  决定回退到上一个有效值或显示红框——本函数只判定合法性。 */
export function isValidCssColor(value: string): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/** 把任意输入归一化成有效的 TaskAppearance。非法 / 缺字段都从
 *  DEFAULT_TASK_APPEARANCE 补齐，保证下游不需要判空。 */
export function normalizeTaskAppearance(raw: unknown): TaskAppearance {
  const base: TaskAppearance = JSON.parse(JSON.stringify(DEFAULT_TASK_APPEARANCE));
  if (raw === null || typeof raw !== 'object') return base;
  const obj = raw as Partial<TaskAppearance> & { colors?: Partial<PriorityColorMap> };
  const mode: TaskAppearanceMode = obj.mode === 'custom' ? 'custom' : 'theme';
  const out: TaskAppearance = {
    mode,
    colors: {
      none:   mergeColor(obj.colors?.none,   base.colors.none),
      low:    mergeColor(obj.colors?.low,    base.colors.low),
      medium: mergeColor(obj.colors?.medium, base.colors.medium),
      high:   mergeColor(obj.colors?.high,   base.colors.high),
    },
  };
  return out;
}

function mergeColor(input: Partial<TaskColorPair> | undefined, fallback: TaskColorPair): TaskColorPair {
  if (!input) return { ...fallback };
  return {
    background: typeof input.background === 'string' && isValidCssColor(input.background) ? input.background : fallback.background,
    foreground: typeof input.foreground === 'string' && isValidCssColor(input.foreground) ? input.foreground : fallback.foreground,
  };
}

/** 给定当前 appearance，找到第一个匹配它的预设 id；custom 模式或主题色
 *  被用户改过都返回 null（Settings UI 据此把下拉切到"自定义"）。mode =
 *  'custom' 时即便颜色和某个预设完全一致也返回 null —— 因为 mode 本身就
 *  表示"用户主动编辑过颜色"的意图。 */
export function presetIdOf(appearance: TaskAppearance): string | null {
  if (appearance.mode === 'custom') return null;
  for (const preset of TASK_APPEARANCE_PRESETS) {
    if (sameColors(preset.value.colors, appearance.colors)) return preset.id;
  }
  return null;
}

function sameColors(a: PriorityColorMap, b: PriorityColorMap): boolean {
  for (const p of PRIORITIES) {
    if (a[p].background.toLowerCase() !== b[p].background.toLowerCase()) return false;
    if (a[p].foreground.toLowerCase() !== b[p].foreground.toLowerCase()) return false;
  }
  return true;
}
