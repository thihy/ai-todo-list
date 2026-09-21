// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Keep the real adapter and ToolRow; stub only the external visual primitives.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = () => null;
  return {
    IconApiOutline14: Icon, IconBrowseOutline16: Icon, IconCodeOutline16: Icon,
    IconEditOutline16: Icon, IconSearchOutline16: Icon, IconSparkle16: Icon, IconInspectOutline12: Icon,
    StateDot: Icon, CodeBlock: Icon, ReadBlock: Icon, SearchBlock: Icon, WebBlock: Icon,
    diffTotals: () => ({ added: 1, removed: 0 }),
    DiffBlock: ({ diffs }: any) => <pre>{JSON.stringify(diffs)}</pre>,
    JsonTree: ({ data }: any) => <pre>{JSON.stringify(data)}</pre>,
    TerminalBlock: ({ output, exitCode, signal }: any) => <pre>{output} exit={exitCode} {signal}</pre>,
    DisclosureRow: ({ open, onToggle, children, title }: any) => <div><button onClick={onToggle}>{title}</button>{open && children}</div>,
  };
});
vi.mock('../../src/renderer/dsh/ui-tool/tool/components/AskQuestionCard', () => ({ AskQuestionCard: () => null }));
import { DomainToolRow } from '../../src/renderer/dsh/DomainToolRow';
import { recoverToolResultValue } from '../../src/shared/tool-presentation';

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(() => { act(() => root.unmount()); element.remove(); });

it('opens long input and output separately, copies original text, and closes', async () => {
  const text = 'not JSON\n  indented\n'.repeat(1000) + 'LAST LINE';
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  act(() => root.render(<DomainToolRow toolName="read" args={{ file_path: 'long.txt' }} argsKnown result={text} resultKnown ok state="done" />));
  const click = (label: string) => act(() => { Array.from(element.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') ?? b.textContent) === label)!.click(); });
  act(() => element.querySelector('button')!.click());
  click('查看完整输出');
  expect(element.querySelector('dialog')?.open).toBe(true);
  expect(element.querySelector('dialog pre')?.textContent).toBe(text);
  expect(element.querySelector('dialog')?.textContent).not.toContain('格式化 JSON');
  await act(async () => { Array.from(element.querySelectorAll('dialog button')).find(b => b.textContent === '复制全文')!.click(); });
  expect(copy).toHaveBeenCalledWith(text);
  click('关闭');
  expect(element.querySelector('dialog')).toBeNull();
  click('查看完整输入');
  expect(element.querySelector('dialog pre')?.textContent).toContain('long.txt');
  act(() => { element.querySelector('dialog')!.dispatchEvent(new Event('cancel')); });
  expect(element.querySelector('dialog')).toBeNull();
});

it('keeps JSON-looking command output as text until formatting is requested', () => {
  const text = '{"answer":42}';
  act(() => root.render(<DomainToolRow toolName="pwsh" args={{ command: 'echo' }} argsKnown result={text} resultKnown ok state="done" />));
  act(() => element.querySelector('button')!.click());
  act(() => Array.from(element.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '查看完整输出')!.click());
  expect(element.querySelector('dialog pre')?.textContent).toBe(text);
  act(() => Array.from(element.querySelectorAll('button')).find(b => b.textContent === '格式化 JSON')!.click());
  expect(element.querySelector('dialog pre')?.textContent).toBe('{\n  "answer": 42\n}');
});

it('does not present pending tool results as failures', () => {
  act(() => root.render(<DomainToolRow toolName="pwsh" args={{ command: 'dir' }} argsKnown result={undefined} resultKnown={false} ok={false} state="running" />));
  act(() => element.querySelector('button')!.click());
  expect(element.textContent).toContain('等待工具返回');
  expect(element.textContent).not.toContain('失败');
  expect(element.textContent).not.toContain('查看完整输出');
});

it('preserves tool error details in the output section', () => {
  act(() => root.render(<DomainToolRow toolName="write" args={{ file_path: 'a' }} argsKnown result="Access denied" resultKnown ok={false} state="error" />));
  act(() => element.querySelector('button')!.click());
  expect(element.textContent).toContain('Access denied');
  expect(element.textContent).toContain('输出');
});

it('detects JSON independently for input and non-JSON output', () => {
  act(() => root.render(<DomainToolRow toolName="read" args={{ file_path: 'a' }} argsKnown result="plain output" resultKnown ok state="done" />));
  act(() => element.querySelector('button')!.click());
  expect(element.querySelector('[aria-label="输入格式化 JSON"]')).not.toBeNull();
  expect(element.querySelector('[aria-label="输出格式化 JSON"]')).toBeNull();
  expect(element.querySelector('[aria-label="查看完整输入"] svg')).not.toBeNull();
  expect(element.querySelector('[aria-label="查看完整输出"] svg')).not.toBeNull();
});

it('toggles input and output JSON views independently', () => {
  act(() => root.render(<DomainToolRow toolName="custom" args={{ input: 1 }} argsKnown result={{ output: 2 }} resultKnown ok state="done" />));
  act(() => element.querySelector('button')!.click());
  const input = element.querySelector<HTMLButtonElement>('[aria-label="输入格式化 JSON"]')!;
  const output = element.querySelector<HTMLButtonElement>('[aria-label="输出格式化 JSON"]')!;
  act(() => input.click());
  expect(input.getAttribute('aria-pressed')).toBe('true');
  expect(output.getAttribute('aria-pressed')).toBe('false');
  act(() => output.click());
  act(() => input.click());
  expect(input.getAttribute('aria-pressed')).toBe('false');
  expect(output.getAttribute('aria-pressed')).toBe('true');
});

it.each([
  ['pwsh', { command: 'Get-ChildItem' }, 'listed-file.txt\n[exit code: 2]', 'listed-file.txt'],
  ['read', { file_path: 'a' }, '<content>\n1: file contents\n</content>', 'file contents'],
  ['write', { file_path: 'a', content: 'new text' }, 'Successfully wrote a', 'Successfully wrote a'],
  ['edit', { file_path: 'a', old_string: 'old', new_string: 'new' }, 'Successfully edited a', 'Successfully edited a'],
  ['grep', { pattern: 'word' }, 'a.txt:3:word', 'a.txt:3:word'],
  ['glob', { pattern: '*.txt' }, 'a.txt\nb.txt', 'b.txt'],
] as const)('expanded %s shows the tool output', (name, args, text, expected) => {
  act(() => root.render(<DomainToolRow toolName={name} args={args} argsKnown result={recoverToolResultValue([{ type: 'text', text }], name)} resultKnown ok state="done" />));
  act(() => element.querySelector('button')!.click());
  expect(element.textContent).toContain(expected);
  expect(element.textContent).toContain('输入');
  if (name === 'pwsh') expect(element.textContent).toContain('exit=2');
  else expect(element.textContent).toContain('输出');
});
