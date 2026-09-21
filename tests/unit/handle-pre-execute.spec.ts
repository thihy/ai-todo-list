// @vitest-environment node
//
// handlePreExecute 单测 —— 锁定 host 审批闸门的三条契约:
//   1. 工作空间路径修改(改 env / 改 settings.json / 改 config.json /
//      rm -rf dsh_workspace)→ 永远 deny,不论 preset 是什么;不弹卡不调 AI
//   2. read 类工具:workspace 内读直通,workspace 外 deny
//   3. mutate 工具:非 auto preset → ask;auto preset → next()(让插件 allow 生效)
//
// 直接调命名导出的 handlePreExecute,不需要 cordis/DSH 全栈。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePreExecute, WORKSPACE_MUTATION_DENY_REASON } from '../../src/main/dsh/dsh-runtime';
import type { PreToolDecision } from '@deepseek-ai/dsh-tools';

// 用真实目录做 workspace —— isWithinWorkspace() 走 realpath,POSIX 风格
// 路径在 win32 上 path.sep 不匹配,会直接 deny 而不是返回 true。
let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hpe-'));
  process.env.DSH_WORKSPACE_ROOT = workspace;
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeDeps(currentPresetValue: string | undefined = 'workspace-write') {
  return {
    settings: { get: () => ({ dshWorkspaceDir: workspace }) },
    currentPreset: vi.fn().mockReturnValue(currentPresetValue),
  };
}

const nextNeverCalled = (): Promise<PreToolDecision> => {
  throw new Error('next() should not have been called');
};

describe('handlePreExecute — 工作空间路径修改黑名单', () => {
  it('bash 设 DSH_WORKSPACE_ROOT 环境变量 → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'export DSH_WORKSPACE_ROOT=/tmp/other' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.reason).toBe(WORKSPACE_MUTATION_DENY_REASON);
    expect(d.currentPreset).not.toHaveBeenCalled();
  });

  it('pwsh 用 $env:DSH_WORKSPACE_ROOT → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'pwsh', arguments: { command: '$env:DSH_WORKSPACE_ROOT = "C:\\other"' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('bash 用 setx 写入注册表 → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'setx DSH_WORKSPACE_ROOT "C:\\other"' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('pwsh Set-Content 写到 settings.json → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'pwsh', arguments: { command: "Set-Content -Path 'C:\\app\\dsh_workspace\\settings.json' -Value '{}'" } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('write 工具直接写 settings.json → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'write', arguments: { file_path: join(workspace, 'settings.json'), content: '{}' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('edit 工具直接编辑 config.json → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'edit', arguments: { file_path: join(workspace, 'config.json'), old_string: 'a', new_string: 'b' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('bash rm -rf dsh_workspace 目录 → deny', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'rm -rf /tmp/app/dsh_workspace' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('危险预设(danger-full-access)也不能绕过 workspace 黑名单', async () => {
    const d = makeDeps('danger-full-access');
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'export DSH_WORKSPACE_ROOT=/tmp/elsewhere' } } as never,
      nextNeverCalled, d,
    );
    // 关键:危险预设下沙箱关闭,但这条策略永远生效
    expect(r.kind).toBe('deny');
  });

  it('auto 预设(插件可能放行)也仍然被 workspace 黑名单拦截', async () => {
    const d = makeDeps('auto');
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: '$env:DSH_WORKSPACE_ROOT = "/tmp/elsewhere"' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
  });

  it('正常 git / ls 命令不被误伤', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'git status && ls -la' } } as never,
      nextNeverCalled, d,
    );
    // 不命中黑名单 → 进入 mutate 闸门 → 非 auto → ask
    expect(r.kind).toBe('ask');
  });

  it('read settings.json(只读意图)不被误伤', async () => {
    const d = makeDeps();
    const next = vi.fn().mockResolvedValue('next-result' as unknown as PreToolDecision);
    const r = await handlePreExecute(
      { name: 'read', arguments: { file_path: join(workspace, 'settings.json') } } as never,
      next, d,
    );
    // read 类工具 workspace 内读 settings.json → 不进黑名单 → next()
    expect(next).toHaveBeenCalledOnce();
    expect(r).toBe('next-result' as unknown as PreToolDecision);
  });
});

describe('handlePreExecute — read 类工具', () => {
  it('workspace 内 read → next()', async () => {
    const d = makeDeps();
    const next = vi.fn().mockResolvedValue('next-result' as unknown as PreToolDecision);
    const r = await handlePreExecute(
      { name: 'read', arguments: { file_path: join(workspace, 'foo.txt') } } as never,
      next, d,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(r).toBe('next-result' as unknown as PreToolDecision);
  });

  it('workspace 外 read → deny(PATH_OUTSIDE_WORKSPACE)', async () => {
    const d = makeDeps();
    const r = await handlePreExecute(
      { name: 'read', arguments: { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.reason).toContain('PATH_OUTSIDE_WORKSPACE');
  });

  it('workspace 内 grep → next()', async () => {
    const d = makeDeps();
    const next = vi.fn().mockResolvedValue('next-result' as unknown as PreToolDecision);
    await handlePreExecute(
      { name: 'grep', arguments: { path: workspace, pattern: 'TODO' } } as never,
      next, d,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('handlePreExecute — mutate 工具', () => {
  it('非 auto preset 调 bash → ask(弹卡)', async () => {
    const d = makeDeps('workspace-write');
    const r = await handlePreExecute(
      { name: 'bash', arguments: { command: 'echo hi', description: '说 hi' } } as never,
      nextNeverCalled, d,
    );
    expect(r.kind).toBe('ask');
    if (r.kind === 'ask') expect(r.reason).toContain('bash');
  });

  it('auto preset 调 bash → next()(插件 allow 才生效)', async () => {
    const d = makeDeps('auto');
    const next = vi.fn().mockResolvedValue('next-result' as unknown as PreToolDecision);
    await handlePreExecute(
      { name: 'bash', arguments: { command: 'echo hi' } } as never,
      next, d,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('其他工具(todo_list) → next()(不归 host 管)', async () => {
    const d = makeDeps();
    const next = vi.fn().mockResolvedValue('next-result' as unknown as PreToolDecision);
    await handlePreExecute(
      { name: 'todo_list', arguments: { status: 'next' } } as never,
      next, d,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
