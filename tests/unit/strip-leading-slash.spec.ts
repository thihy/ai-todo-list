// @vitest-environment node
//
// stripLeadingSlashCommand —— 用户从 Claude Code 等客户端带过来的"打 / 开头"
// 习惯要自动归一化。本应用没有 slash command,所以 `/help` 等价于发 `help`。
// 规则:
//   - 仅剥离首位 `/` + 紧随的 0~1 个 ASCII 空格
//   - 中段 / 末段 / URL 里的 `/` 一律不动
//   - 空字符串 / 不以 `/` 开头 → 原样

import { describe, expect, it } from 'vitest';
import { stripLeadingSlashCommand } from '../../src/renderer/panes/AIPane';

describe('stripLeadingSlashCommand', () => {
  it('/help → help', () => {
    expect(stripLeadingSlashCommand('/help')).toBe('help');
  });

  it('/ help → help(吃掉 / 后面的 1 个空格)', () => {
    expect(stripLeadingSlashCommand('/ help')).toBe('help');
  });

  it('/clear → clear', () => {
    expect(stripLeadingSlashCommand('/clear')).toBe('clear');
  });

  it('/clear all → clear all(只吃紧邻 1 个空格)', () => {
    // 注意:首字符是 /,紧随一个空格,剥掉得 "clear all";中间的空格保留
    expect(stripLeadingSlashCommand('/clear all')).toBe('clear all');
  });

  it('//foo → /foo(只剥首个)', () => {
    expect(stripLeadingSlashCommand('//foo')).toBe('/foo');
  });

  it('不以 / 开头 → 原样', () => {
    expect(stripLeadingSlashCommand('help')).toBe('help');
    expect(stripLeadingSlashCommand('  hello')).toBe('  hello');
    expect(stripLeadingSlashCommand('这是一个 /test 路径')).toBe('这是一个 /test 路径');
  });

  it('空字符串 → 空字符串', () => {
    expect(stripLeadingSlashCommand('')).toBe('');
  });

  it('单字符 / → 空字符串', () => {
    expect(stripLeadingSlashCommand('/')).toBe('');
  });

  it('单字符 / 后跟空格 → 空字符串', () => {
    expect(stripLeadingSlashCommand('/ ')).toBe('');
  });

  it('https://example.com → 原样(只剥首位)', () => {
    // URL 首字符不是 /,所以根本不进 strip
    expect(stripLeadingSlashCommand('https://example.com')).toBe('https://example.com');
  });

  it('/path/to/file → path/to/file', () => {
    expect(stripLeadingSlashCommand('/path/to/file')).toBe('path/to/file');
  });
});
