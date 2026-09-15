// Natural-language capture preview. Parses freeform text into structured todo
// fields (title / dueAt / priority / tags) using lightweight heuristics so it
// works even when the DSH AI runtime is offline. The renderer's composer uses
// this to preview how a capture will be filed; the full text is still stored
// as the todo body so nothing the user typed is lost.

import { okResult, register } from './router';
import type { ParsedTodo } from '../../shared/ai-types';
import { logger } from '../logger';

export function registerCapturePreviewHandler(): void {
  register('ai.parseCapturePreview', (_e, req) => {
    const text = req.text ?? '';
    const parsed = parse(text);
    logger.info(
      `capture preview: title="${parsed.title}" due=${parsed.dueAt} prio=${parsed.priority} tags=${parsed.tags.length}`,
    );
    const { title, dueAt, priority, tags } = parsed;
    return Promise.resolve(
      okResult({ title, dueAt, priority, tags } satisfies ParsedTodo),
    );
  });
  logger.info('ai.parseCapturePreview handler registered');
}

interface ParseResult {
  title: string;
  dueAt: number | null;
  priority: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
  tags: string[];
  cleaned: string;
}

function parse(input: string): ParseResult {
  let text = input;
  const tags = new Set<string>();

  // #tag extraction
  text = text.replace(/(?:^|\s)#([\p{L}\p{N}_-]{1,32})/gu, (_m, t) => {
    tags.add(String(t));
    return ' ';
  });

  // Priority: !vh / !高 / !medium / !m / !med / !低 / !vl / !极低 ... 5 档
  // 显式命中才算优先级；用户没写 !mark 时落到默认档 low（与 todo_create
  // 默认行为一致 —— 不再像旧版那样默认成 "无 / none"）。
  let priority: ParseResult['priority'] = 'low';
  const prioMap: Record<string, ParseResult['priority']> = {
    'very-high': 'very-high', vh: 'very-high', '极高': 'very-high', '很高': 'very-high',
    high: 'high', h: 'high', '高': 'high',
    medium: 'medium', med: 'medium', m: 'medium', '中': 'medium',
    low: 'low', l: 'low', '低': 'low',
    'very-low': 'very-low', vl: 'very-low', '极低': 'very-low', '很低': 'very-low',
  };
  text = text.replace(/(?:^|\s)!([a-zA-Z一-龥]{1,4})/g, (_m, p) => {
    const key = String(p).toLowerCase();
    if (prioMap[key]) priority = prioMap[key];
    return ' ';
  });

  // Due date extraction. First match wins; we scan several patterns.
  let dueAt: number | null = null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const tryDue = (re: RegExp, fn: (m: RegExpMatchArray) => Date | null): boolean => {
    if (dueAt) return true;
    const m = text.match(re);
    if (m) {
      const d = fn(m);
      if (d) {
        dueAt = d.getTime();
        text = text.replace(m[0], ' ');
      }
    }
    return !!dueAt;
  };

  // ISO YYYY-MM-DD
  tryDue(/(?:^|\s)(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  });
  // MM/DD or MM-DD (this year, or next if past)
  tryDue(/(?:^|\s)(\d{1,2})[/-](\d{1,2})(?![\d-])/, (m) => {
    let d = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d < today) d = new Date(today.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  });
  // Chinese relative words
  const relWords: [RegExp, number][] = [
    [/今天|今日/, 0],
    [/明天|明日/, 1],
    [/后天/, 2],
    [/大后天/, 3],
  ];
  for (const [re, addDays] of relWords) {
    if (dueAt) break;
    const m = text.match(re);
    if (m) {
      const d = new Date(today);
      d.setDate(d.getDate() + addDays);
      dueAt = d.getTime();
      text = text.replace(m[0], ' ');
    }
  }
  // 下周X / 周X / 星期X
  const weekdayMap: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  };
  tryDue(/(?:下周|下星期|星期|周)([一二三四五六日天])/, (m) => {
    const target = weekdayMap[m[1]];
    if (target === undefined) return null;
    const next = m[0].startsWith('下') ? 7 : 0;
    const d = new Date(today);
    let delta = (target - d.getDay() + 7) % 7;
    if (next) delta += 7;
    if (delta === 0 && next === 0) delta = 7; // "周三" today is Wed → next Wed
    d.setDate(d.getDate() + delta);
    return d;
  });

  // Title: first non-empty line of what remains; cleaned keeps full body.
  const cleaned = text.replace(/\s+\n/g, '\n').trim();
  const firstLine = cleaned.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = (firstLine || cleaned || '(无标题)').slice(0, 200);

  return { title, dueAt, priority, tags: Array.from(tags), cleaned };
}
