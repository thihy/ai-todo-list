// AI 工具授权表（OPENSPEC §ai-assistant Persistent and session tool grants）。
//
// 覆盖 dsh-runtime.ts 导出的 session-grant Map API：
//   - grantSessionTool(convId, toolName)  → 幂等；按 convId 隔离
//   - revokeSessionTool(convId, toolName) → 删除条目；空 convId set 自动清掉
//   - listSessionGranted(convId)          → 快照数组
//   - clearSessionGrants(convId)          → 整条会话清掉
//
// always 授权在 settings.aiGrantedTools 里（持久化），由 approval/request 监听器
// 短路；此处只测 session 内存态。always 路径的短路通过 ai-handlers 的 grantAlways
// 走 settings.patch → settings.get 读取 → 监听器内比对，间接由
// tests/unit/dedupe/ai-handlers.spec.ts 覆盖到。
//
// Map 在 dsh-runtime 模块作用域（const sessionGrantsByConv = new Map()）；
// 各测试间必须先 clearSessionGrants，否则跨测共享状态会污染。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  grantSessionTool,
  revokeSessionTool,
  listSessionGranted,
  clearSessionGrants,
} from '../../src/main/dsh/dsh-runtime';

const CONV_A = 'conv-A';
const CONV_B = 'conv-B';

beforeEach(() => {
  // 模块级 Map 跨测污染 → 每个测前清干净
  clearSessionGrants(CONV_A);
  clearSessionGrants(CONV_B);
});

describe('grantSessionTool', () => {
  it('grants a tool for a single conversation', () => {
    grantSessionTool(CONV_A, 'write');
    expect(listSessionGranted(CONV_A)).toEqual(['write']);
  });

  it('is idempotent — re-granting the same tool does not duplicate', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'write');
    expect(listSessionGranted(CONV_A)).toEqual(['write']);
  });

  it('isolates by conversationId — conv B does not see conv A grants', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_B, 'bash');
    expect(listSessionGranted(CONV_A)).toEqual(['write']);
    expect(listSessionGranted(CONV_B)).toEqual(['bash']);
  });

  it('returns silently on empty inputs (defensive)', () => {
    grantSessionTool('', 'write');
    grantSessionTool(CONV_A, '');
    expect(listSessionGranted(CONV_A)).toEqual([]);
    expect(listSessionGranted('')).toEqual([]);
  });

  it('accumulates multiple tools for the same conversation', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'edit');
    grantSessionTool(CONV_A, 'bash');
    expect(new Set(listSessionGranted(CONV_A))).toEqual(new Set(['write', 'edit', 'bash']));
  });
});

describe('revokeSessionTool', () => {
  it('returns true when the tool was previously granted', () => {
    grantSessionTool(CONV_A, 'write');
    expect(revokeSessionTool(CONV_A, 'write')).toBe(true);
    expect(listSessionGranted(CONV_A)).toEqual([]);
  });

  it('returns false when the tool was not granted', () => {
    expect(revokeSessionTool(CONV_A, 'write')).toBe(false);
  });

  it('keeps other tools in the same conversation intact', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'bash');
    revokeSessionTool(CONV_A, 'write');
    expect(listSessionGranted(CONV_A)).toEqual(['bash']);
  });

  it('drops the conversation entry when the last tool is revoked (no leaks)', () => {
    grantSessionTool(CONV_A, 'write');
    revokeSessionTool(CONV_A, 'write');
    // listSessionGranted returns [] for empty / missing — caller can't tell
    // the difference; that's fine because revoke-when-empty is a no-op.
    expect(listSessionGranted(CONV_A)).toEqual([]);
    // Re-grant still works (key got cleaned up).
    grantSessionTool(CONV_A, 'edit');
    expect(listSessionGranted(CONV_A)).toEqual(['edit']);
  });
});

describe('listSessionGranted', () => {
  it('returns [] for a conversation that has no grants', () => {
    expect(listSessionGranted(CONV_A)).toEqual([]);
  });

  it('returns a snapshot (mutating the returned array does not change the Map)', () => {
    grantSessionTool(CONV_A, 'write');
    const snapshot = listSessionGranted(CONV_A);
    snapshot.push('bash');
    // The Map still has only 'write' — listSessionGranted returns a fresh
    // array each call, so caller mutations are harmless.
    expect(listSessionGranted(CONV_A)).toEqual(['write']);
  });
});

describe('clearSessionGrants', () => {
  it('removes all grants for a conversation', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_A, 'bash');
    clearSessionGrants(CONV_A);
    expect(listSessionGranted(CONV_A)).toEqual([]);
  });

  it('does not touch other conversations', () => {
    grantSessionTool(CONV_A, 'write');
    grantSessionTool(CONV_B, 'bash');
    clearSessionGrants(CONV_A);
    expect(listSessionGranted(CONV_A)).toEqual([]);
    expect(listSessionGranted(CONV_B)).toEqual(['bash']);
  });
});