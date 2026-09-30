// @vitest-environment happy-dom
//
// MarkdownEditor 粘贴图片 → 自动上传到任务 attachments/ 并在光标处插入
// Markdown 图片引用（`![alt](attachment://<id>)`）。本测试锁定：
//   - 单图粘贴：占位行先出现，上传成功后被替换为 attachment://<id>
//   - 多图粘贴：按当前顺序插入；每张独立 fire-and-forget 上传
//   - 非图片 / 没 todoId：什么都不做，textarea 默认粘贴行为保留
//   - 上传失败：占位行换成一行错误注释，工具栏短促显示原因

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// HistoryPopover 调 useGitHistory → window.todoList.document.*。Mock 掉直接
// 返回空 history，让工具栏只剩一颗 IconHistory 按钮 —— 不参与 paste 测试。
vi.mock('../../src/renderer/components/HistoryPopover', () => ({
  HistoryPopover: () => null,
}));
// MarkdownText 来自 dsh-client-ui-primitives；mock 成「保留 text +
// pathImages.resolve(url) 后的结果」两个字段，方便断言 pathImages 钩子
// 真的把 attachment://<id> 翻译成了 data: URL。避免在 happy-dom 里拉
// mermaid / shiki 等运行时。
type CapturedPathImages = {
  resolve: (value: string) => string | undefined;
} | undefined;
let captured: { text: string; resolved: Record<string, string | undefined> };
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({
    text,
    pathImages,
  }: {
    text: string;
    pathImages?: CapturedPathImages;
  }) => {
    const resolved: Record<string, string | undefined> = {};
    const re = /attachment:\/\/([A-Za-z0-9_-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]!;
      resolved[id] = pathImages?.resolve(`attachment://${id}`);
    }
    captured = { text, resolved };
    return React.createElement('div', { 'data-testid': 'preview' }, text);
  },
}));

import { MarkdownEditor } from '../../src/renderer/components/MarkdownEditor';

let root: Root;
let container: HTMLDivElement;
let attachBlob: ReturnType<typeof vi.fn>;
let inboxRead: ReturnType<typeof vi.fn>;
let documentCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  // 重置 view-persistence —— 之前的「预览」测试会写到 localStorage，
  // 不重置下一个 mount 就只渲染 MarkdownText 而 textarea 缺失了。
  try { localStorage.removeItem('todo-list.mdView'); } catch { /* noop */ }
  attachBlob = vi.fn();
  inboxRead = vi.fn();
  // MarkdownEditor.paste 成功后调 document.create({kind:'attachment',...})
  // 给图片建 companion task_document 行，让后续附件 rename → MD alt 同步
  // 有起点（旧 alt 就是这个 row 的 title）。
  documentCreate = vi.fn().mockResolvedValue({ ok: true, data: { id: 'fake-attdoc' } });
  (window as unknown as {
    todoList: {
      inbox: {
        attachBlob: typeof attachBlob;
        read: typeof inboxRead;
      };
      document: {
        create: typeof documentCreate;
      };
    };
  }).todoList = {
    inbox: { attachBlob, read: inboxRead },
    document: { create: documentCreate },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mountEditor(value: string, todoId?: string): void {
  root = createRoot(container);
  act(() => {
    root.render(
      <MarkdownEditor
        docId="doc-1"
        {...(todoId !== undefined ? { todoId } : {})}
        value={value}
        version={1}
        onSave={async () => undefined}
        saving={false}
        error={null}
      />,
    );
  });
}

function getTextarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not found');
  return el;
}

function dispatchPaste(file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = getTextarea();
  act(() => {
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
}

/** 等 attachBlob 被调用一次。FileReader.readAsDataURL 在 happy-dom 下是
 *  完全异步（事件循环下一轮才触发 onload），所以 paste 处理器要等一两个
 *  microtask 才能真正调到 inbox.attachBlob。 */
async function waitForAttachCall(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (attachBlob.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('attachBlob was never called within 50 ticks');
}

describe('MarkdownEditor image paste', () => {
  it('单图粘贴：占位行立即出现，上传成功后替换为 attachment://<id>', async () => {
    let resolveUpload!: (value: { ok: true; data: { id: string } }) => void;
    attachBlob.mockImplementation(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );

    mountEditor('hello world', 'todo-abc');

    const file = new File(['fake-bytes'], 'shot.png', { type: 'image/png' });
    dispatchPaste(file);

    // 落盘前：占位行已经出现在正文里（attachment://pending/<key>）
    const placeholder = /!\[pasted-(\d{8})-(\d{6})-1\]\(attachment:\/\/pending\/paste-\d+-0\)/;
    expect(getTextarea().value).toMatch(placeholder);

    // 等 FileReader 异步 onload + 微任务队列跑完，让 attachBlob 真正被调一次
    await waitForAttachCall();

    // 上传成功后：占位行被替换成 attachment://<id>
    await act(async () => {
      resolveUpload({ ok: true, data: { id: 'attach-id-1' } });
      // 等所有微任务跑完，包括 applyEdit 内部的 setMd + requestAnimationFrame
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getTextarea().value).toContain('![pasted-');
    expect(getTextarea().value).toContain('](attachment://attach-id-1)');
    expect(getTextarea().value).not.toContain('pending');
    expect(attachBlob).toHaveBeenCalledTimes(1);
    expect(attachBlob.mock.calls[0]![0]).toMatchObject({
      todoId: 'todo-abc',
      // filename 现在是确定时间戳（pasted-YYYYMMDD-HHMMSS-i），不用剪贴板里的真实名
      filename: expect.stringMatching(/^pasted-\d{8}-\d{6}-1$/),
      mime: 'image/png',
    });
  });

  it('多图粘贴：每张占位一行，独立并发上传，全部成功后替换完成', async () => {
    const resolvers: Array<(value: { ok: true; data: { id: string } }) => void> = [];
    attachBlob.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    mountEditor('body', 'todo-xyz');

    dispatchPaste(new File(['a'], 'a.png', { type: 'image/png' }));
    dispatchPaste(new File(['b'], 'b.png', { type: 'image/png' }));

    // 同一 ms 内两张：占位 key 用 index 区分
    const value = getTextarea().value;
    expect(value).toContain('attachment://pending/paste-');
    expect(value.match(/attachment:\/\/pending\//g)?.length).toBe(2);

    // 等两次 attachBlob 都被调起来
    for (let i = 0; i < 50 && resolvers.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    await act(async () => {
      resolvers[0]!({ ok: true, data: { id: 'id-a' } });
      resolvers[1]!({ ok: true, data: { id: 'id-b' } });
      // 等所有微任务跑完，包括 applyEdit 内部的 setMd + requestAnimationFrame
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    const after = getTextarea().value;
    expect(after).toContain('attachment://id-a');
    expect(after).toContain('attachment://id-b');
    expect(after).not.toContain('pending');
  });

  it('上传失败：占位行换成错误注释，工具栏显示原因', async () => {
    attachBlob.mockResolvedValue({
      ok: false,
      code: 'attach_blob_failed',
      message: '磁盘满',
    });

    mountEditor('', 'todo-fail');

    dispatchPaste(new File(['x'], 'x.png', { type: 'image/png' }));

    // 这次 attachBlob 是同步 resolve，但 onPaste 的 catch 也在 microtask 上跑
    await waitForAttachCall();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const value = getTextarea().value;
    expect(value).toContain('> ⚠️ 图片上传失败');
    expect(value).toContain('磁盘满');
    expect(container.querySelector('.md-editor__status--error')?.textContent).toContain('粘贴图片失败');
  });

  it('没 todoId：图片粘贴静默 no-op，不调 attachBlob', async () => {
    mountEditor('body'); // todoId 缺省

    dispatchPaste(new File(['x'], 'x.png', { type: 'image/png' }));

    // 等一拍确保即使用户意外传了 todoId 也不会出现异步 attachBlob 调用
    await new Promise((r) => setTimeout(r, 5));

    // 不该出现 attachment:// 占位（MarkdownEditor 缺 todoId 时直接 return）
    expect(getTextarea().value).toBe('body');
    expect(attachBlob).not.toHaveBeenCalled();
  });

  it('纯文本粘贴：MarkdownEditor 不拦截（textarea 默认行为）', async () => {
    mountEditor('hi ', 'todo-mix');

    // happy-dom 不支持 items.add(string)，但 items 长度为 0 同样能验证
    // 「没有 image 文件时不调 attachBlob」这个契约 —— onPaste 遍历 items，
    // 没 image/* 就直接 return，不会去碰 textarea 也不会调 inbox。
    const dt = new DataTransfer();
    expect(dt.items.length).toBe(0);
    const ta = getTextarea();
    act(() => {
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    });

    await new Promise((r) => setTimeout(r, 5));
    // 没 image 项 → attachBlob 不该被调；textarea 内容不变
    expect(attachBlob).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe('hi ');
  });

  it('预览：attachment://<id> 经 pathImages 翻译成 data: URL（MarkdownText 协议白名单放行）', async () => {
    // inbox.read 返回 data URL —— InboxStore.read 内部把字节编成 base64
    // data: URL 返回。这条契约保证 Preview 端永远拿不到绝对路径。
    inboxRead.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ ok: true, data: { dataUrl: `data:image/png;base64,AA${id}`, mime: 'image/png', filename: `${id}.png` } }),
    );

    // 初始 markdown 直接写「已替换好的图片行」，绕开 paste 异步上传的不确定性
    // —— 这条测试只关心 Preview 翻译路径，不重复测 paste 主路径。
    mountEditor('![shot](attachment://abc-1)', 'todo-preview');

    // 切到「预览」视图（默认就是 'write'，需要点一下 status bar 切到
    // 'preview' 才能让 Preview 挂载并发起 inbox.read）。
    await act(async () => {
      const previewBtn = container.querySelector<HTMLButtonElement>(
        '.editor-statusbar__view-btn:nth-child(2)',
      );
      previewBtn?.click();
      // 让 Preview useEffect 跑起来 + Promise.all inbox.read 全部 resolve
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // pathImages.resolve 真的把 attachment://abc-1 翻译成了 data: URL
    expect(inboxRead).toHaveBeenCalledWith({ id: 'abc-1' });
    expect(captured).toBeDefined();
    expect(captured.resolved['abc-1']).toBe('data:image/png;base64,AAabc-1');
  });

  it('预览：inbox.read 失败时 pathImages 命中不了，markdown 图片行退化成 alt 文本', async () => {
    inboxRead.mockResolvedValue({ ok: false, code: 'inbox_read_failed', message: '文件丢失' });

    mountEditor('![shot](attachment://missing)', 'todo-x');
    await act(async () => {
      const previewBtn = container.querySelector<HTMLButtonElement>(
        '.editor-statusbar__view-btn:nth-child(2)',
      );
      previewBtn?.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 返回 undefined → MarkdownText 走 alt 文本占位（mock 把 resolved[id]
    // 设成 undefined 就是这个语义）
    expect(captured.resolved['missing']).toBeUndefined();
  });

  it('粘贴：用「pasted-YYYYMMDD-HHMMSS-i」作为 alt + filename + companion doc title', async () => {
    let resolveUpload!: (value: { ok: true; data: { id: string } }) => void;
    attachBlob.mockImplementation(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );

    mountEditor('', 'todo-named');
    dispatchPaste(new File(['x'], 'real-shot.png', { type: 'image/png' }));

    // 等上传发起
    await waitForAttachCall();

    // attachBlob 的 filename 参数走时间戳格式，不再用剪贴板里的真实文件名。
    // 这是「rename IPC 能精准替换 alt」的前提 —— 后续用户改名附件时，
    // inbox.rename 会扫所有 ![oldAlt](attachment://<id>)，把 oldAlt 替换成
    // 新 title；oldAlt = 时间戳形式 + i 对应 to 就能定位。
    expect(attachBlob.mock.calls[0]![0]).toMatchObject({
      todoId: 'todo-named',
      mime: 'image/png',
    });
    const filename = attachBlob.mock.calls[0]![0]!.filename as string;
    expect(filename).toMatch(/^pasted-\d{8}-\d{6}-1$/);
    expect(filename).not.toContain('real-shot');

    // 上传成功后 alt 也是同样格式（同一变量 baseName 拼出来的）。
    await act(async () => {
      resolveUpload({ ok: true, data: { id: 'att-abc' } });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    const expectedAlt = filename; // 时间戳名字 = alt
    expect(getTextarea().value).toContain(`![${expectedAlt}](attachment://att-abc)`);

    // document.create({kind:'attachment', title, refId}) 也被调，title 与
    // alt 完全一致 —— 这是 inbox.rename 同步替换 MD alt 的起点。
    expect(documentCreate).toHaveBeenCalledWith({
      todoId: 'todo-named',
      kind: 'attachment',
      title: expectedAlt,
      refId: 'att-abc',
    });
  });

  it('多图粘贴：每张 alt 是 pasted-YYYYMMDD-HHMMSS-i，i 递增', async () => {
    const resolvers: Array<(value: { ok: true; data: { id: string } }) => void> = [];
    attachBlob.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    mountEditor('', 'todo-multi');
    dispatchPaste(new File(['a'], 'a.png', { type: 'image/png' }));
    dispatchPaste(new File(['b'], 'b.png', { type: 'image/png' }));

    // 等两次 upload 发起
    for (let i = 0; i < 50 && resolvers.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    await act(async () => {
      resolvers[0]!({ ok: true, data: { id: 'att-1' } });
      resolvers[1]!({ ok: true, data: { id: 'att-2' } });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 两次 attachBlob 的 filename 分别带 -1 和 -2 后缀
    const f1 = attachBlob.mock.calls[0]![0]!.filename as string;
    const f2 = attachBlob.mock.calls[1]![0]!.filename as string;
    expect(f1).toMatch(/pasted-\d{8}-\d{6}-1$/);
    expect(f2).toMatch(/pasted-\d{8}-\d{6}-2$/);
    expect(getTextarea().value).toContain(`![${f1}](attachment://att-1)`);
    expect(getTextarea().value).toContain(`![${f2}](attachment://att-2)`);
    // companion doc 各建一条
    expect(documentCreate).toHaveBeenCalledTimes(2);
    expect(documentCreate.mock.calls[0]![0]).toMatchObject({
      kind: 'attachment',
      title: f1,
      refId: 'att-1',
    });
    expect(documentCreate.mock.calls[1]![0]).toMatchObject({
      kind: 'attachment',
      title: f2,
      refId: 'att-2',
    });
  });
});