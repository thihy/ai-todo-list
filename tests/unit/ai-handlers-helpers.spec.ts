// L3-D helpers: isDefaultTitle + autoTitleFromPrompt. Both are tiny pure
// functions but they're the gate that decides whether a conversation gets
// renamed or keeps its default title — a regression here would silently
// revert every chat to "新对话 <timestamp>".

import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/main/ipc/ai-handlers';

const { isDefaultTitle, autoTitleFromPrompt } = __testing;

describe('isDefaultTitle', () => {
  it('matches ConversationRepo.create output (新对话 <timestamp>)', () => {
    expect(isDefaultTitle('新对话 2026/9/8 14:30:00')).toBe(true);
    expect(isDefaultTitle('新对话 ')).toBe(true);
  });

  it('matches the L3-C migration fallback', () => {
    expect(isDefaultTitle('未命名对话')).toBe(true);
  });

  it('does not match user-chosen titles', () => {
    expect(isDefaultTitle('今日计划')).toBe(false);
    expect(isDefaultTitle('新对话')).toBe(false); // no trailing space → not the create output
    expect(isDefaultTitle('新对话计划')).toBe(false); // substring but no separator
  });

  it('does not match an auto-derived title', () => {
    expect(isDefaultTitle('查找本周高优 TODO')).toBe(false);
  });
});

describe('autoTitleFromPrompt', () => {
  it('returns the prompt unchanged when short enough', () => {
    expect(autoTitleFromPrompt('查找高优')).toBe('查找高优');
  });

  it('truncates with ellipsis when over the limit', () => {
    const long = '这个查询超过了十六个字符所以应该被截断';
    const out = autoTitleFromPrompt(long);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace (newlines, tabs, multiple spaces) to one', () => {
    expect(autoTitleFromPrompt('hello\n\n   world\t\tfoo')).toBe('hello world foo');
  });

  it('trims leading/trailing whitespace', () => {
    expect(autoTitleFromPrompt('   查找 TODO  ')).toBe('查找 TODO');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(autoTitleFromPrompt('   \n\t  ')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(autoTitleFromPrompt('')).toBe('');
  });
});