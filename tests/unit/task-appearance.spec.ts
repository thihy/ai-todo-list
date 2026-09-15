// task-appearance — pure-function coverage for normalizeTaskAppearance,
// normalizeCustomPresets, and presetIdOf. No DOM, no React.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TASK_APPEARANCE,
  PRESET_SOFT_COLORS,
  PRESET_WHITE_ON_BLACK,
  MAX_CUSTOM_PRESETS,
  normalizeCustomPresets,
  normalizeTaskAppearance,
  presetIdOf,
  type PriorityColorMap,
  type TaskAppearanceCustomPreset,
} from '../../src/shared/task-appearance';

const customColor = (bg: string, fg = '#000000'): PriorityColorMap => ({
  none:   { background: bg, foreground: fg },
  low:    { background: bg, foreground: fg },
  medium: { background: bg, foreground: fg },
  high:   { background: bg, foreground: fg },
});

describe('normalizeTaskAppearance', () => {
  it('returns DEFAULT for null / non-object input', () => {
    expect(normalizeTaskAppearance(null)).toEqual(DEFAULT_TASK_APPEARANCE);
    expect(normalizeTaskAppearance(undefined)).toEqual(DEFAULT_TASK_APPEARANCE);
    expect(normalizeTaskAppearance('string')).toEqual(DEFAULT_TASK_APPEARANCE);
  });

  it('preserves explicit theme mode + DEFAULT colors', () => {
    expect(normalizeTaskAppearance({ mode: 'theme', colors: DEFAULT_TASK_APPEARANCE.colors })).toEqual(DEFAULT_TASK_APPEARANCE);
  });

  it('migrates theme mode + non-default colors to custom', () => {
    const result = normalizeTaskAppearance({
      mode: 'theme',
      colors: { none: { background: '#ABCDEF', foreground: '#000000' } },
    });
    expect(result.mode).toBe('custom');
    expect(result.colors.none.background).toBe('#ABCDEF');
  });

  it('preserves explicit custom mode', () => {
    const result = normalizeTaskAppearance(PRESET_WHITE_ON_BLACK);
    expect(result.mode).toBe('custom');
    expect(result.colors).toEqual(PRESET_WHITE_ON_BLACK.colors);
  });

  it('infers theme when mode missing and colors = DEFAULT', () => {
    expect(normalizeTaskAppearance({ colors: DEFAULT_TASK_APPEARANCE.colors }).mode).toBe('theme');
  });

  it('infers custom when mode missing and colors diverge from DEFAULT', () => {
    expect(normalizeTaskAppearance({ colors: customColor('#123456') }).mode).toBe('custom');
  });

  it('drops invalid colors back to DEFAULT slot', () => {
    const result = normalizeTaskAppearance({
      mode: 'custom',
      colors: { none: { background: 'not-a-color', foreground: 'also-bad' } },
    });
    expect(result.colors.none).toEqual(DEFAULT_TASK_APPEARANCE.colors.none);
  });
});

describe('normalizeCustomPresets', () => {
  it('returns [] for null / non-array input', () => {
    expect(normalizeCustomPresets(null)).toEqual([]);
    expect(normalizeCustomPresets(undefined)).toEqual([]);
    expect(normalizeCustomPresets({})).toEqual([]);
  });

  it('keeps valid entries', () => {
    const list: TaskAppearanceCustomPreset[] = [
      { id: 'a', label: '深色', colors: customColor('#101010') },
      { id: 'b', label: '工作', colors: customColor('#FAFAFA') },
    ];
    expect(normalizeCustomPresets(list)).toEqual(list);
  });

  it('drops entries with empty id / label', () => {
    const result = normalizeCustomPresets([
      { id: '', label: 'x', colors: customColor('#000000') },
      { id: 'ok', label: '', colors: customColor('#000000') },
      { id: 'fine', label: 'fine', colors: customColor('#000000') },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fine');
  });

  it('drops entries with invalid colors and falls back per-slot to DEFAULT', () => {
    const result = normalizeCustomPresets([
      { id: 'x', label: 'broken', colors: { none: { background: 'rgb()', foreground: 'nope' } } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].colors.none).toEqual(DEFAULT_TASK_APPEARANCE.colors.none);
    expect(result[0].colors.low).toEqual(DEFAULT_TASK_APPEARANCE.colors.low);
  });

  it('dedupes by id (first wins)', () => {
    const result = normalizeCustomPresets([
      { id: 'dup', label: 'first', colors: customColor('#111111') },
      { id: 'dup', label: 'second', colors: customColor('#222222') },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('first');
    expect(result[0].colors.none.background).toBe('#111111');
  });

  it(`caps at ${MAX_CUSTOM_PRESETS} entries`, () => {
    const tooMany = Array.from({ length: MAX_CUSTOM_PRESETS + 5 }, (_, i) => ({
      id: `id-${i}`,
      label: `L${i}`,
      colors: customColor('#000000'),
    }));
    const result = normalizeCustomPresets(tooMany);
    expect(result).toHaveLength(MAX_CUSTOM_PRESETS);
    expect(result[0].id).toBe('id-0');
    expect(result[MAX_CUSTOM_PRESETS - 1].id).toBe(`id-${MAX_CUSTOM_PRESETS - 1}`);
  });

  it('trims label whitespace', () => {
    const result = normalizeCustomPresets([
      { id: 'a', label: '  深色  ', colors: customColor('#000000') },
    ]);
    expect(result[0].label).toBe('深色');
  });
});

describe('presetIdOf', () => {
  it('returns theme for mode=theme + DEFAULT colors', () => {
    expect(presetIdOf(DEFAULT_TASK_APPEARANCE, [])).toBe('theme');
  });

  it('returns custom for mode=theme + non-DEFAULT colors', () => {
    const result = presetIdOf(
      { mode: 'theme', colors: customColor('#ABCDEF') },
      [],
    );
    expect(result).toBe('custom');
  });

  it('ignores user presets in theme mode even if colors match', () => {
    // A user preset with DEFAULT colors + custom mode would match under custom;
    // theme mode is a hard boundary and must always classify as 'theme' when
    // colors = DEFAULT, regardless of any user preset.
    const userPreset: TaskAppearanceCustomPreset = {
      id: 'user-default',
      label: 'defaults-as-custom',
      colors: DEFAULT_TASK_APPEARANCE.colors,
    };
    expect(presetIdOf(DEFAULT_TASK_APPEARANCE, [userPreset])).toBe('theme');
  });

  it('matches custom-mode + user preset colors', () => {
    const userPreset: TaskAppearanceCustomPreset = {
      id: 'user-1',
      label: '深色',
      colors: customColor('#101010'),
    };
    const result = presetIdOf(
      { mode: 'custom', colors: customColor('#101010') },
      [userPreset],
    );
    expect(result).toBe('user-1');
  });

  it('user preset colors matching built-in still picks user (user-first ordering)', () => {
    // PRESET_WHITE_ON_BLACK has #FFFFFF/#000000. A user preset with the same
    // colors should win, because user presets are checked first in custom
    // mode — that's the whole point of letting users "own" a colour profile.
    const dupWhite: TaskAppearanceCustomPreset = {
      id: 'my-white',
      label: '我的白底黑字',
      colors: PRESET_WHITE_ON_BLACK.colors,
    };
    expect(
      presetIdOf(PRESET_WHITE_ON_BLACK, [dupWhite]),
    ).toBe('my-white');
  });

  it('falls back to built-in when no user preset matches', () => {
    const userPreset: TaskAppearanceCustomPreset = {
      id: 'user-1',
      label: '深色',
      colors: customColor('#101010'),
    };
    expect(
      presetIdOf(PRESET_SOFT_COLORS, [userPreset]),
    ).toBe('soft');
  });

  it('returns custom when no preset matches', () => {
    const userPreset: TaskAppearanceCustomPreset = {
      id: 'user-1',
      label: '深色',
      colors: customColor('#101010'),
    };
    expect(
      presetIdOf(
        { mode: 'custom', colors: customColor('#ABCDEF') },
        [userPreset],
      ),
    ).toBe('custom');
  });

  it('returns first match when two user presets share colors', () => {
    const a: TaskAppearanceCustomPreset = {
      id: 'a',
      label: 'A',
      colors: customColor('#777777'),
    };
    const b: TaskAppearanceCustomPreset = {
      id: 'b',
      label: 'B',
      colors: customColor('#777777'),
    };
    expect(
      presetIdOf(
        { mode: 'custom', colors: customColor('#777777') },
        [a, b],
      ),
    ).toBe('a');
  });

  it('treats DEFAULT colors in custom mode as custom (not theme)', () => {
    // Important: user explicitly chose custom mode with default colours
    // must NOT silently flip to 'theme' — that would snap the dropdown back
    // and erase the user's intent.
    const result = presetIdOf(
      { mode: 'custom', colors: DEFAULT_TASK_APPEARANCE.colors },
      [],
    );
    expect(result).toBe('custom');
  });
});

describe('built-in preset invariants', () => {
  // 无优先级与低优先级共用同一组色 —— 让优先级升档的视觉对比更清晰，
  // 避免 4 个色阶都太接近。任意内置预设改了 none/low 都会破坏这一不变量。
  it.each([
    ['DEFAULT_TASK_APPEARANCE', DEFAULT_TASK_APPEARANCE.colors],
    ['PRESET_WHITE_ON_BLACK', PRESET_WHITE_ON_BLACK.colors],
    ['PRESET_SOFT_COLORS', PRESET_SOFT_COLORS.colors],
  ])('%s: none === low', (_name, colors) => {
    expect(colors.none).toEqual(colors.low);
  });
});
