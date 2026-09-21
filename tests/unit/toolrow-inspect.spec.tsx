// @vitest-environment happy-dom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror the existing test's DisclosureRow mock so we test the real ToolRow
// against a row whose header has onClick=onToggle (expandOnRowClick=true).
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
    DisclosureRow: ({ open, onToggle, expandable, children, title, collapsedContent }: any) => (
      <div data-disclosure-row>
        <div data-disclosure-header onClick={expandable ? onToggle : undefined} role={expandable ? 'button' : undefined}>
          {title}
          {collapsedContent}
        </div>
        {open && children}
      </div>
    ),
  };
});
vi.mock('../../src/renderer/dsh/ui-tool/tool/components/AskQuestionCard', () => ({ AskQuestionCard: () => null }));

import { ToolRow } from '../../src/renderer/dsh/ui-tool/tool/components/ToolRow';
import { conversationT } from '../../src/renderer/dsh/conversation-locale';

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div'); document.body.append(element);
});
afterEach(() => { act(() => root.unmount()); element.remove(); });

describe('ToolPayloadDialog survives React StrictMode dev double-invoke', () => {
  it('inspect button still opens a visible dialog under StrictMode', () => {
    const text = 'not JSON\n'.repeat(200);
    root = createRoot(element);
    act(() => {
      root.render(
        <StrictMode>
          <ToolRow
            t={conversationT}
            variant="read"
            icon={null}
            title="读取文件"
            summary="long.txt"
            bodyRaw={'{"file_path": "long.txt"}'}
            output={null}
            fullOutput={text}
            read={{ label: 'long.txt', lines: text.split('\n'), totalLines: 200, lang: 'plaintext' }}
            showInputWithCard
            state="done"
          />
        </StrictMode>,
      );
    });
    // Expand the row.
    act(() => { element.querySelector('[data-disclosure-header]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(element.querySelector('[aria-label="查看完整输出"]')).not.toBeNull();
    // Click the inspect button. Under StrictMode the Dialog will mount →
    // unmount (cleanup runs node.close()) → the cleanup's close() event
    // bubbles into the React `onClose` handler, which calls setPayload(null)
    // and the StrictMode remount finds payload===null so the dialog stays
    // closed. The user reports the icon "doesn't react".
    act(() => {
      element.querySelector('[aria-label="查看完整输出"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(element.querySelector('dialog[open]')).not.toBeNull();
  });
});