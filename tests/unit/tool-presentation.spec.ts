// Tool-presentation 投影单测（OPENSPEC §ai-assistant Filesystem and shell tools
// registered with DSH）。
//
// 覆盖三类映射：
//   1. presentToolResult 路由：read → ReadBlock / write → DiffBlock /
//      bash → TerminalBlock（不投影会退化成 JsonBlock——plan O6 提到）
//   2. helpers (readResultToView / writeEditToView / grepResultToView /
//      globResultToView / bashToView) 解析 DSH 0.1.5-rc.2 wire 形状
//   3. summarizeToolCall collapsed-row 摘要（file path / command / pattern）

import { describe, it, expect } from 'vitest';
import {
  presentToolResult,
  presentToolCall,
  summarizeToolCall,
  recoverToolResultValue,
} from '../../src/shared/tool-presentation';
import {
  readResultToView,
  writeEditToView,
  grepResultToView,
  globResultToView,
  bashToView,
} from '../../src/shared/tool-presentation-helpers';

describe('actual DSH rendered result content', () => {
  it.each(['read', 'read_image', 'grep', 'glob'])('%s preserves its text envelope', name => {
    const text = '<path>C:\\work\\a.txt</path>\n<content>\n1: hello\n</content>';
    const result = recoverToolResultValue([{ type: 'text', text }], name);
    expect(presentToolResult(name, {}, result, true)).toMatchObject({ card: 'generic', content: [{ type: 'text', text }] });
  });
  it('keeps JSON-looking shell output verbatim and domain JSON structured', () => {
    const content = [{ type: 'text', text: '{"answer":42}' }];
    expect(recoverToolResultValue(content, 'pwsh')).toBe('{"answer":42}');
    expect(recoverToolResultValue(content, 'todo_get')).toEqual({ answer: 42 });
  });
  it('retains every text block and identifies non-text results', () => {
    expect(recoverToolResultValue([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, { type: 'image' }]))
      .toBe('first\n\nsecond\n\n[image 内容]');
  });
  it('preserves stderr and timeout while deriving terminal exit status', () => {
    expect(bashToView('pwsh', {}, 'output\n[stderr]\nerror\n[timed out after 1000ms]\n[exit code: 1]'))
      .toMatchObject({ output: 'output\n[stderr]\nerror\n[timed out after 1000ms]', exitCode: 1 });
    expect(bashToView('bash', {}, 'partial\n[killed by signal: SIGTERM]'))
      .toMatchObject({ output: 'partial', signal: 'SIGTERM' });
  });
  it('supports canonical shell stdout/stderr envelopes', () => {
    expect(bashToView('pwsh', {}, { stdout: { text: 'out' }, stderr: { text: 'err' }, exitCode: 2 }))
      .toMatchObject({ output: 'out\n[stderr]\nerr', exitCode: 2 });
  });
  it('uses the real edit parameter names', () => {
    expect(writeEditToView('edit', { file_path: 'a', old_string: 'before', new_string: 'after' }, 'Successfully edited'))
      .toMatchObject({ diffs: [{ path: 'a', oldText: 'before', newText: 'after' }] });
  });
  it('keeps Windows drive letters in grep matches', () => {
    expect(grepResultToView({}, { output: 'C:\\work\\a.txt:12:hello: world' }))
      .toMatchObject({ files: [{ path: 'C:\\work\\a.txt', matches: [{ lineNumber: 12, line: 'hello: world' }] }] });
  });
});

// ─── presentToolResult routing ──────────────────────────────────────────────

describe('presentToolResult — DSH fs / shell routing', () => {
  it('routes read → ReadBlock (card: "read")', () => {
    const view = presentToolResult(
      'read',
      { file_path: 'notes.md' },
      { output: '1│hello' },
      true,
    );
    expect(view.card).toBe('read');
  });

  it('routes read_image → ReadBlock (card: "read")', () => {
    const view = presentToolResult(
      'read_image',
      { file_path: 'shot.png' },
      { output: '' },
      true,
    );
    expect(view.card).toBe('read');
  });

  it('routes write → DiffBlock (card: "diff")', () => {
    const view = presentToolResult(
      'write',
      { file_path: 'a.txt', content: 'hello' },
      { ok: true },
      true,
    );
    expect(view.card).toBe('diff');
  });

  it('routes edit → DiffBlock (card: "diff")', () => {
    const view = presentToolResult(
      'edit',
      { file_path: 'a.txt', old_text: 'old', new_text: 'new' },
      { ok: true },
      true,
    );
    expect(view.card).toBe('diff');
  });

  it('routes grep → SearchBlock matches (card: "search", shape: "matches")', () => {
    const view = presentToolResult(
      'grep',
      { pattern: 'TODO', path: '.' },
      { output: 'a.ts:1:hello\nb.ts:3:TODO' },
      true,
    );
    if (view.card !== 'search') throw new Error('expected card: search');
    expect(view.shape).toBe('matches');
  });

  it('routes glob → SearchBlock paths (card: "search", shape: "paths")', () => {
    const view = presentToolResult(
      'glob',
      { pattern: '*.md' },
      ['a.md', 'b.md'],
      true,
    );
    if (view.card !== 'search') throw new Error('expected card: search');
    expect(view.shape).toBe('paths');
  });

  it('routes bash → TerminalBlock (card: "terminal")', () => {
    const view = presentToolResult(
      'bash',
      { command: 'echo hi' },
      { output: 'hi\n', exitCode: 0 },
      true,
    );
    expect(view.card).toBe('terminal');
  });

  it('routes pwsh → TerminalBlock (card: "terminal")', () => {
    const view = presentToolResult(
      'pwsh',
      { command: 'Get-Location' },
      { output: 'C:\\Workspace', exitCode: 0 },
      true,
    );
    expect(view.card).toBe('terminal');
  });

  it('falls back to errorResult when ok=false', () => {
    // errorResult returns card: 'generic' (JsonBlock fallback) so the user
    // still sees the failure reason; not a dedicated error card primitive.
    const view = presentToolResult('write', { file_path: 'a.txt' }, { message: 'denied' }, false);
    expect(view.card).toBe('generic');
  });

  it('falls back to errorResult when result is null', () => {
    const view = presentToolResult('read', { file_path: 'a.txt' }, null, true);
    expect(view.card).toBe('generic');
  });
});

// ─── helpers — readResultToView ───────────────────────────────────────────

describe('readResultToView', () => {
  it('parses DSH numbered-line format "<num>│<text>" into ReadFileLine[]', () => {
    const view = readResultToView(
      { file_path: 'a.txt' },
      { output: '1│hello\n2│world' },
    );
    if (view.card !== 'read') throw new Error('expected read');
    expect(view.path).toBe('a.txt');
    expect(view.lines).toEqual([
      { number: 1, text: 'hello' },
      { number: 2, text: 'world' },
    ]);
  });

  it('uses explicit lines[] when result carries them (range read)', () => {
    const view = readResultToView(
      { file_path: 'a.txt' },
      { lines: [{ number: 5, text: 'hi' }] },
    );
    if (view.card !== 'read') throw new Error('expected read');
    expect(view.lines).toEqual([{ number: 5, text: 'hi' }]);
  });

  it('falls back to a row with no number when "│" is missing', () => {
    const view = readResultToView(
      { file_path: 'a.txt' },
      { output: 'no separator' },
    );
    if (view.card !== 'read') throw new Error('expected read');
    expect(view.lines[0]).toEqual({ number: 1, text: 'no separator' });
  });

  it('path falls back to args.path when result has no file_path', () => {
    const view = readResultToView(
      { path: 'b.txt' },
      { output: '1│x' },
    );
    expect(view.path).toBe('b.txt');
  });

  it('returns "unknown" when neither args nor result carry a path', () => {
    const view = readResultToView({}, { output: '1│x' });
    expect(view.path).toBe('unknown');
  });
});

// ─── helpers — writeEditToView ────────────────────────────────────────────

describe('writeEditToView', () => {
  it('write uses args.content as the newText', () => {
    const view = writeEditToView(
      'write',
      { file_path: 'a.txt', content: 'hello' },
      { ok: true },
    );
    if (view.card !== 'diff') throw new Error('expected diff');
    expect(view.diffs[0]).toMatchObject({
      path: 'a.txt',
      newText: 'hello',
    });
  });

  it('edit uses result.newText when available', () => {
    const view = writeEditToView(
      'edit',
      { file_path: 'a.txt', old_text: 'old', new_text: 'should-not-use' },
      { ok: true, newText: 'new' },
    );
    if (view.card !== 'diff') throw new Error('expected diff');
    expect(view.diffs[0]).toMatchObject({
      path: 'a.txt',
      newText: 'new',
    });
  });

  it('edit falls back to args.new_text when result.newText absent', () => {
    const view = writeEditToView(
      'edit',
      { file_path: 'a.txt', new_text: 'new' },
      { ok: true },
    );
    if (view.card !== 'diff') throw new Error('expected diff');
    expect(view.diffs[0]?.newText).toBe('new');
  });
});

// ─── helpers — grepResultToView ───────────────────────────────────────────

describe('grepResultToView', () => {
  it('groups matches by file', () => {
    const view = grepResultToView(
      { pattern: 'TODO', path: '.' },
      { output: 'a.ts:1:hello\nb.ts:3:TODO\na.ts:7:foo' },
    );
    if (view.card !== 'search') throw new Error('expected search');
    if (view.shape !== 'matches') throw new Error('expected matches');
    const fileMap = new Map(view.files.map((f) => [f.path, f.matches.length]));
    expect(fileMap.get('a.ts')).toBe(2);
    expect(fileMap.get('b.ts')).toBe(1);
  });

  it('returns empty files[] on empty output', () => {
    const view = grepResultToView(
      { pattern: 'TODO' },
      { output: '' },
    );
    if (view.card !== 'search') throw new Error('expected search');
    expect(view.files).toEqual([]);
    expect(view.total).toBe(0);
  });

  it('uses the search root path when a match has no colon-prefixed file', () => {
    const view = grepResultToView(
      { pattern: 'TODO', path: '/root' },
      { output: 'no-colon-here' },
    );
    if (view.card !== 'search') throw new Error('expected search');
    expect(view.files[0]?.path).toBe('/root');
  });
});

// ─── helpers — globResultToView ───────────────────────────────────────────

describe('globResultToView', () => {
  it('handles the array-of-strings shape', () => {
    const view = globResultToView(
      { pattern: '*.md' },
      ['a.md', 'b.md'],
    );
    if (view.card !== 'search') throw new Error('expected search');
    if (view.shape !== 'paths') throw new Error('expected paths');
    expect(view.paths).toEqual(['a.md', 'b.md']);
    expect(view.total).toBe(2);
  });

  it('handles the { files: string[] } envelope', () => {
    const view = globResultToView(
      { pattern: '*.md' },
      { files: ['a.md'] },
    );
    expect(view.paths).toEqual(['a.md']);
  });

  it('returns empty paths[] when result is missing', () => {
    const view = globResultToView({ pattern: '*.md' }, null);
    expect(view.paths).toEqual([]);
    expect(view.total).toBe(0);
  });
});

// ─── helpers — bashToView ─────────────────────────────────────────────────

describe('bashToView', () => {
  it('uses result.output (merged stdout+stderr) — not separate stdout/stderr', () => {
    const view = bashToView(
      'bash',
      { command: 'echo hi' },
      { output: 'hi\n', exitCode: 0 },
    );
    expect(view.card).toBe('terminal');
    expect(view.output).toBe('hi\n');
  });

  it('falls back to result.stdout when output is absent', () => {
    const view = bashToView(
      'bash',
      { command: 'x' },
      { stdout: 'fallback', exitCode: 0 },
    );
    expect(view.output).toBe('fallback');
  });

  it('forwards exitCode to the TerminalBlock', () => {
    const view = bashToView('bash', { command: 'x' }, { output: 'oops', exitCode: 1 });
    expect(view.exitCode).toBe(1);
  });

  it('title is prefixed with the tool name + truncated command', () => {
    const view = bashToView('pwsh', { command: 'Get-Location' }, { output: '', exitCode: 0 });
    expect(view.title).toMatch(/^pwsh · Get-Location$/);
  });

  it('command arg is read from args.script as a fallback', () => {
    // Some shell tool envelopes use `script` instead of `command` —
    // bashToView should still derive a meaningful title.
    const view = bashToView(
      'bash',
      { script: 'echo fallback' },
      { output: 'fallback\n' },
    );
    expect(view.title).toMatch(/echo fallback/);
  });
});

// ─── summarizeToolCall collapsed-row text ─────────────────────────────────

describe('summarizeToolCall — fs / shell collapsed row', () => {
  it('read → file path', () => {
    expect(summarizeToolCall('read', { file_path: 'docs/spec.md' }, undefined, true))
      .toBe('docs/spec.md');
  });

  it('write → file path + byte count', () => {
    const s = summarizeToolCall('write', { file_path: 'a.txt', content: 'hello' }, { ok: true }, true);
    expect(s).toContain('a.txt');
    expect(s).toContain('5 bytes');
  });

  it('edit → file path', () => {
    expect(summarizeToolCall('edit', { file_path: 'a.txt' }, { ok: true }, true))
      .toBe('a.txt');
  });

  it('bash → command', () => {
    expect(summarizeToolCall('bash', { command: 'ls -la' }, { output: '' }, true))
      .toBe('ls -la');
  });

  it('pwsh → command', () => {
    expect(summarizeToolCall('pwsh', { command: 'Get-Process' }, { output: '' }, true))
      .toBe('Get-Process');
  });

  it('grep → pattern', () => {
    expect(summarizeToolCall('grep', { pattern: 'TODO' }, { output: '' }, true))
      .toBe('TODO');
  });

  it('glob → pattern', () => {
    expect(summarizeToolCall('glob', { pattern: '*.md' }, ['a.md'], true))
      .toBe('*.md');
  });

  it('description field takes priority over the structured subject', () => {
    expect(summarizeToolCall(
      'read',
      { file_path: 'long/path.md', description: '查看规范文件' },
      undefined,
      true,
    )).toBe('查看规范文件');
  });
});

// ─── presentToolCall shape ────────────────────────────────────────────────

describe('presentToolCall — fs / shell', () => {
  it('returns a generic call card with the right kind', () => {
    const call = presentToolCall('write', { file_path: 'a.txt' });
    expect(call.card).toBe('generic');
    expect(call.kind).toBe('edit');
    expect(call.title).toBe('写入文件');
  });

  it('bash maps to kind="other" (terminal-style render)', () => {
    const call = presentToolCall('bash', { command: 'ls' });
    expect(call.kind).toBe('other');
  });

  it('grep maps to kind="search"', () => {
    expect(presentToolCall('grep', { pattern: 'TODO' }).kind).toBe('search');
  });
});
