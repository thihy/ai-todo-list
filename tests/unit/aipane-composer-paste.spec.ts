// @vitest-environment happy-dom
// AI 助手输入框粘贴图片 → 字节流落到 dsh_workspace/inbox/，以绝对路径进
// prompt。本测试锁定三件事：
//   - 正常粘贴：落盘 + chip 出现，importBlob 拿到当前 convId 和 data: URL
//   - 竞态：粘完立刻回车（importBlob 还没返回）附件仍进 prompt，不静默丢图
//   - 失败：importBlob 报错时提示写进输入框，且不加 chip
// 名字规则（通用 image.png → pasted-<n>.<ext>）由 pastedFileName 单测覆盖。
//
// 断言时机的坑：React 在 async act 退出时才 flush，所以轮询的是 mock 调用
// （非 React 状态），断言放在 act 之外。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AIStreamEvent } from '../../src/shared/ai-types';

interface Attachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

const harness = vi.hoisted(() => ({
  events: [] as AIStreamEvent[],
  subscribers: new Set<() => void>(),
  appListeners: new Map<string, (request: unknown) => void>(),
  composer: null as null | {
    value: string;
    onChange(text: string): void;
    onSubmit(): void;
    onSteer(): void;
    onStop(): void;
    onPasteFiles(files: File[]): void;
    attachments: readonly Attachment[];
    busy: boolean;
  },
  follow: { showJumpToLatest: false, jumpToLatest: () => {}, requestFollow: () => {} },
}));
vi.mock('../../src/renderer/hooks/useTodoListApi', async () => {
  const react = await import('react');
  return {
    useAiStream: () => ({
      events: react.useSyncExternalStore(callback => {
        harness.subscribers.add(callback);
        return () => { harness.subscribers.delete(callback); };
      }, () => harness.events),
      clear: () => { harness.events = []; harness.subscribers.forEach(f => f()); },
    }),
    useAppEvent: (name: string, handler: (value: unknown) => void) => react.useEffect(() => {
      harness.appListeners.set(name, handler);
      return () => { harness.appListeners.delete(name); };
    }, [name, handler]),
    useProviderStatus: () => ({ state: 'ready' }),
    useSettings: () => ({ data: { provider: 'deepseek', model: 'test' } }),
    useStartupAiState: () => ({ state: { status: 'ready' }, retry: vi.fn() }),
  };
});
vi.mock('../../src/renderer/hooks/useChatAutoFollow', () => ({ useChatAutoFollow: () => harness.follow }));
vi.mock('../../src/renderer/data-bus', () => ({ useDataVersion: () => 0 }));
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconEnhanceOutline16: () => null, IconPlusOutline16: () => null,
  IconPaperclipOutline16: () => null, IconWarningOutline16: () => null,
  IconChevronDownOutline14: () => null, Button: () => null,
}));
vi.mock('../../src/renderer/components/icons', () => ({ IconHistory: () => null, IconCollapseBar: () => null }));
vi.mock('../../src/renderer/components/Composer', () => ({ AI_SUBMIT_EVENT: 'test:submit' }));
vi.mock('../../src/renderer/dsh/AIComposer', async () => {
  const react = await import('react');
  return { AIComposer: react.forwardRef((props: NonNullable<typeof harness.composer>, _ref) => {
    harness.composer = props;
    return null;
  }) };
});
vi.mock('../../src/renderer/dsh/PendingQuestionCard', () => ({ PendingQuestionCard: () => null }));
vi.mock('../../src/renderer/dsh/PendingApprovalCard', () => ({ PendingApprovalCard: () => null }));
vi.mock('../../src/renderer/components/AiCreateTaskMessage', () => ({ AiCreateTaskMessage: () => null }));
vi.mock('../../src/renderer/dsh/AssistantTurnContent', () => ({ AssistantTurnContent: () => null }));

import {
  AIPane,
  attachmentHeader,
  parseAttachedBlocks,
  pastedFileName,
} from '../../src/renderer/panes/AIPane';

let root: Root;
let container: HTMLDivElement;
let ask: ReturnType<typeof vi.fn>;
let importBlob: ReturnType<typeof vi.fn>;
let relinkDraft: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  harness.events = [];
  ask = vi.fn().mockResolvedValue({ ok: true, data: { content: 'ok' } });
  relinkDraft = vi.fn().mockResolvedValue({ ok: true, data: { moved: 1 } });
  importBlob = vi.fn().mockImplementation(({ name, mime }: { name: string; mime: string }) =>
    Promise.resolve({
      ok: true,
      data: { path: `C:/inbox/${name}`, name, mime, size: 4 },
    }),
  );
  const conversation = { id: 'conv-1', title: 'test', updatedAt: 0, archived: false };
  window.todoList = {
    ai: { ask, steer: vi.fn().mockResolvedValue({ ok: true, data: { accepted: true } }), cancel: vi.fn().mockResolvedValue({ ok: true }) },
    conversation: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { conversations: [conversation], total: 1, remaining: 0 } }),
      history: vi.fn().mockResolvedValue({ ok: true, data: { turns: [] } }),
    },
    app: { importBlob, relinkDraft },
  } as unknown as typeof window.todoList;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(AIPane)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  harness.appListeners.clear();
});

/** happy-dom 的 FileReader.readAsDataURL 在下一个事件循环才触发 onload，
 *  importBlob 之前还有一次微任务，所以轮询而不是死等一拍。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not met in time');
}

/** 让 importBlob 的 .then / .catch 链在 act 内跑完。 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function png(name = 'image.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

describe('AIPane composer paste image', () => {
  it('queues text and image snapshots then sends them in order after completion', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('second'); harness.composer!.onPasteFiles([png('queued.png')]); await settle(); });
    await act(async () => { harness.composer!.onSubmit(); await waitFor(() => importBlob.mock.calls.length === 1); await settle(); });
    await act(async () => { harness.composer!.onChange('third'); });
    await act(async () => { harness.composer!.onSubmit(); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[aria-label^="编辑排队消息"]')).toHaveLength(2);
    expect(harness.composer!.value).toBe('');
    await act(async () => { finish({ ok: true, data: { content: 'done' } }); await settle(); });
    await act(async () => { await settle(); });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[1][0].prompt).toContain('second');
    expect(ask.mock.calls[1][0].prompt).toContain('queued.png');
    expect(ask.mock.calls[2][0].prompt).toBe('third');
    expect(ask.mock.calls.every(([args]) => args.conversationId === 'conv-1')).toBe(true);
  });

  it('lets the user remove a queued message without affecting the active response', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('remove me'); });
    await act(async () => { harness.composer!.onSubmit(); });
    await act(async () => { (container.querySelector('[aria-label="移除排队消息 1"]') as HTMLButtonElement).click(); });
    await act(async () => { finish({ ok: true, data: {} }); await settle(); });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('pauses queued messages after failure until explicitly resumed', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('second'); });
    await act(async () => { harness.composer!.onSubmit(); });
    await act(async () => { finish({ ok: false, message: 'offline' }); await settle(); });
    expect(ask).toHaveBeenCalledTimes(1);
    const resume = [...container.querySelectorAll('button')].find((button) => button.textContent === '继续发送队列');
    expect(resume).toBeDefined();
    await act(async () => { resume!.click(); await settle(); });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps the queue paused after Stop even when the old response settles later', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('after stop'); });
    await act(async () => { harness.composer!.onSubmit(); });
    await act(async () => { harness.composer!.onStop(); await settle(); });
    await act(async () => { finish({ ok: true, data: { content: 'late response' } }); await settle(); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="编辑排队消息 1"]')).not.toBeNull();
    const resume = [...container.querySelectorAll('button')].find((button) => button.textContent === '继续发送队列');
    await act(async () => { resume!.click(); await settle(); });
    expect(ask.mock.calls[1][0].prompt).toBe('after stop');
  });

  it('uses steer during the active invocation and preserves the draft on rejection', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('use Chinese'); });
    await act(async () => { harness.composer!.onSteer(); await settle(); });
    expect(window.todoList.ai.steer).toHaveBeenCalledWith({ conversationId: 'conv-1', invocationId: ask.mock.calls[0][0].invocationId, prompt: 'use Chinese' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('引导当前任务');
    vi.mocked(window.todoList.ai.steer).mockResolvedValueOnce({ ok: false, code: 'steer_failed', message: 'failed' });
    await act(async () => { harness.composer!.onChange('keep draft'); });
    await act(async () => { harness.composer!.onSteer(); await settle(); });
    expect(harness.composer!.value).toBe('keep draft');
    await act(async () => { finish({ ok: true, data: {} }); await settle(); });
  });

  it('falls back to queue when the active invocation ends before steer arrives', async () => {
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(window.todoList.ai.steer).mockResolvedValueOnce({ ok: true, data: { accepted: false } });
    await act(async () => { harness.composer!.onChange('first'); });
    await act(async () => { harness.composer!.onSubmit(); await settle(); });
    await act(async () => { harness.composer!.onChange('racing steer'); });
    await act(async () => { harness.composer!.onSteer(); await settle(); });
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, data: {} }); await settle(); });
    expect(ask.mock.calls[1][0].prompt).toBe('racing steer');
  });
  it('shows retry for rejected IPC requests and leaves retry available after another failure', async () => {
    ask.mockRejectedValueOnce(new Error('connection lost'));
    ask.mockResolvedValueOnce({ ok: false, message: 'still unavailable' });
    await act(async () => { harness.composer!.onChange('重试这个问题'); });
    await act(async () => { harness.composer!.onSubmit(); });
    let retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '重试')!;
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '重试')!;
    expect(retry).toBeDefined();
    expect(retry.disabled).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('.turn .bubble--user')).toHaveLength(1);
  });
  it('retries a failed image message without losing attachments, duplicating the bubble or clearing the draft', async () => {
    ask.mockResolvedValueOnce({ ok: false, message: 'temporary failure' });
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      await waitFor(() => importBlob.mock.calls.length > 0);
      await settle();
    });
    await act(async () => { harness.composer!.onChange('看看这张图'); });
    await act(async () => { harness.composer!.onSubmit(); });
    const original = ask.mock.calls[0]![0];
    await act(async () => { harness.composer!.onChange('未发送的草稿'); });
    const retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '重试')!;
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); retry.click(); });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0].prompt).toBe(original.prompt);
    expect(ask.mock.calls[1]![0].conversationId).toBe(original.conversationId);
    expect(ask.mock.calls[1]![0].invocationId).not.toBe(original.invocationId);
    expect(ask.mock.calls[1]![0].retryGroupId).toBe(original.retryGroupId);
    expect(container.querySelectorAll('.turn .bubble--user')).toHaveLength(1);
    expect(harness.composer!.value).toBe('未发送的草稿');
  });
  it('只粘贴图片也能发送，等待落盘后将图片路径交给 DSH', async () => {
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      harness.composer!.onSubmit();
      await waitFor(() => ask.mock.calls.length > 0);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0].prompt).toContain('C:/inbox/pasted-0.png');
    expect(ask.mock.calls[0]![0].prompt).toContain('read_image');
  });
  it('落盘到当前会话的 inbox，并以绝对路径进 prompt', async () => {
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      await waitFor(() => importBlob.mock.calls.length > 0);
      await settle();
    });

    expect(importBlob).toHaveBeenCalledTimes(1);
    const arg = importBlob.mock.calls[0]![0] as {
      conversationId: string | null;
      name: string;
      mime: string;
      dataUrl: string;
    };
    expect(arg.conversationId).toBe('conv-1');
    expect(arg.mime).toBe('image/png');
    expect(arg.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(harness.composer!.attachments).toHaveLength(1);
    expect(harness.composer!.attachments[0]!.path).toBe('C:/inbox/pasted-0.png');

    await act(async () => { harness.composer!.onChange('看看这张图'); });
    await act(async () => { harness.composer!.onSubmit(); });
    const prompt = ask.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('看看这张图');
    expect(prompt).toContain('[attached: pasted-0.png (image/png, 4 字节) — 别用 read 读它');
    expect(prompt).toContain('C:/inbox/pasted-0.png');
  });

  it('粘完立刻回车会等落盘完成，不静默丢图', async () => {
    let release!: (value: unknown) => void;
    importBlob.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    // 真实文件名（非通用 image.*）原样保留
    const file = new File([new Uint8Array([1, 2, 3, 4])], '架构图.jpg', { type: 'image/jpeg' });
    await act(async () => { harness.composer!.onChange('这张图是什么'); });
    await act(async () => {
      harness.composer!.onPasteFiles([file]);
      harness.composer!.onSubmit();
      // 等 importBlob 真正被调用：此时 runSubmit 卡在 settlePendingPastes
      await waitFor(() => importBlob.mock.calls.length > 0);
    });
    // 落盘没回来就不能发出去 —— 否则附件被静默丢掉
    expect(ask).not.toHaveBeenCalled();

    await act(async () => {
      release({
        ok: true,
        data: { path: 'C:/inbox/架构图.jpg', name: '架构图.jpg', mime: 'image/jpeg', size: 4 },
      });
      await waitFor(() => ask.mock.calls.length > 0);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    const prompt = ask.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('这张图是什么');
    expect(prompt).toContain('[attached: 架构图.jpg (image/jpeg, 4 字节) — 别用 read 读它');
    expect(prompt).toContain('C:/inbox/架构图.jpg');
  });

  it('落盘失败时提示写进输入框，且不加 chip', async () => {
    importBlob.mockImplementationOnce(() => Promise.resolve({ ok: false, message: '磁盘写入失败' }));
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      await waitFor(() => importBlob.mock.calls.length > 0);
      await settle();
    });
    expect(harness.composer!.attachments).toHaveLength(0);
    expect(harness.composer!.value).toContain('无法附加图片');
    expect(harness.composer!.value).toContain('磁盘写入失败');
  });

  it('draft 态落盘的附件在提交时 relink 到正式会话（否则删会话时文件泄漏）', async () => {
    // main 的 resolveTarget 产出的 draft 文件名是 `c-draft-<ulid>-<原名>`。
    // 匹配锚在路径末尾的 `c-draft-[^/\\]+$` 能吃到整个 basename（其中不含
    // 分隔符），所以这条路径必须真的被 relink —— 实测它确实生效。
    const draftPath = 'C:/inbox/c-draft-01ABCDEF-pasted-0.png';
    importBlob.mockImplementationOnce(({ name, mime }: { name: string; mime: string }) =>
      Promise.resolve({ ok: true, data: { path: draftPath, name, mime, size: 4 } }),
    );
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      await waitFor(() => importBlob.mock.calls.length > 0);
      await settle();
    });
    await act(async () => { harness.composer!.onChange('看图'); });
    await act(async () => { harness.composer!.onSubmit(); });

    expect(relinkDraft).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      paths: [draftPath],
    });
  });

  it('已有正式会话的附件不触发 relinkDraft（幂等，避免多余 IPC）', async () => {
    const convPath = 'C:/inbox/c-01M31W5E9EA5HRAHVT15TADK38-01ABCDEF-pasted-0.png';
    importBlob.mockImplementationOnce(({ name, mime }: { name: string; mime: string }) =>
      Promise.resolve({ ok: true, data: { path: convPath, name, mime, size: 4 } }),
    );
    await act(async () => {
      harness.composer!.onPasteFiles([png()]);
      await waitFor(() => importBlob.mock.calls.length > 0);
      await settle();
    });
    await act(async () => { harness.composer!.onChange('看图'); });
    await act(async () => { harness.composer!.onSubmit(); });
    expect(relinkDraft).not.toHaveBeenCalled();
  });
});

describe('attachmentHeader', () => {
  it(
    '禁止用 read 读图片，并无条件点名 read_image',
    () => {
      const h = attachmentHeader({
        path: 'C:/inbox/a.png',
        name: 'a.png',
        mime: 'image/png',
        size: 70,
      });
      expect(h).toBe(
        '[attached: a.png (image/png, 70 字节) — 别用 read 读它，二进制会报错并中断本轮；图片一律用 read_image 直接看图，不要用 OCR 或 pwsh/bash 解析]',
      );
      expect(h).toContain('read_image');
    },
  );

  it(
    '不再把 pwsh 写成读图的可用退路 —— 那条路只会诱发 OCR',
    () => {
      const h = attachmentHeader({ path: 'C:/inbox/a.png', name: 'a.png', mime: 'image/png', size: 70 });
      // pwsh 仍出现在「不要用」的禁令里，但不能再被表述成「工具集里没有就
      // 用它」的备选方案。旧文案是「工具集里没有就用 pwsh 解析」。
      expect(h).not.toContain('工具集里没有');
      expect(h).toContain('不要用 OCR');
    },
  );

  it(
    '非图片附件也带同一条禁令，避免模型套用图片读法',
    () => {
      const h = attachmentHeader({ path: 'C:/i/a.txt', name: 'a.txt', mime: 'text/plain', size: 12 });
      expect(h.startsWith('[attached: a.txt (text/plain, 12 字节)')).toBe(true);
      expect(h).toContain('read_image');
    },
  );

  it(
    'header 必须单行、且不含会破坏历史回放正则的 ] —— 新增提示语不能回归',
    () => {
      const h = attachmentHeader({ path: 'C:/i/a.png', name: 'a.png', mime: 'image/png', size: 1 });
      expect(h).not.toContain('\n');
      expect(h.slice(0, -1)).not.toContain(']');
    },
  );
});

describe('parseAttachedBlocks', () => {
  it('解析新格式（带读工具提示）并从正文剥掉', () => {
    const raw =
      '看看这张图\n\n---\n\n[attached: a.png (image/png, 70 字节) — 别用 read 读它，二进制会报错并中断本轮；优先用 read_image，工具集里没有就用 pwsh 解析]\nC:/inbox/a.png';
    const { attached, userText } = parseAttachedBlocks(raw);
    expect(attached).toEqual([{ name: 'a.png', mime: 'image/png', size: 70, path: 'C:/inbox/a.png' }]);
    expect(userText).toBe('看看这张图');
  });

  it('仍能解析旧格式（无提示语）—— 已有会话重启回放不能丢附件', () => {
    const raw =
      '老消息\n\n---\n\n[attached: a.txt (text/plain, 12 字节)]\nC:/inbox/a.txt';
    const { attached, userText } = parseAttachedBlocks(raw);
    expect(attached).toEqual([{ name: 'a.txt', mime: 'text/plain', size: 12, path: 'C:/inbox/a.txt' }]);
    expect(userText).toBe('老消息');
  });

  it('多个附件，以及没有附件的普通消息', () => {
    const raw =
      '两个\n\n---\n\n[attached: a.png (image/png, 1 字节) — 别用 read 读它…优先用 read_image]\nC:/i/a.png' +
      '\n\n---\n\n[attached: b.txt (text/plain, 2 字节) — 别用 read 读它…优先用 read_image]\nC:/i/b.txt';
    const { attached, userText } = parseAttachedBlocks(raw);
    expect(attached.map((a) => a.name)).toEqual(['a.png', 'b.txt']);
    expect(userText).toBe('两个');

    const none = parseAttachedBlocks('纯文字消息');
    expect(none.attached).toEqual([]);
    expect(none.userText).toBe('纯文字消息');
  });
});

describe('pastedFileName', () => {
  const file = (name: string, type: string): File => new File([new Uint8Array([1])], name, { type });

  it.each([
    ['', 'image/png', 'pasted-3.png'],
    ['image.png', 'image/png', 'pasted-3.png'],
    ['image.jpeg', 'image/jpeg', 'pasted-3.jpg'],
    ['image', 'image/tiff', 'pasted-3.tiff'],
    ['架构图.png', 'image/png', '架构图.png'],
    ['shot.webp', 'image/webp', 'shot.webp'],
  ])('%s + %s -> %s', (name, type, expected) => {
    expect(pastedFileName(file(name, type), 3)).toBe(expected);
  });
});
