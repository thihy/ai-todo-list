// Permission tier classification for AI tools. The runtime MUST gate every
// tool call through tierFor() before executing — auto runs without prompting,
// notify-undo surfaces an undo toast for 8s, block requires explicit user
// confirmation.
//
// Tool names use the underscored form registered in
// src/main/dsh/dsh-runtime.ts registerDomainTools() — keep them in sync.

export const SAFE_TOOLS: ReadonlySet<string> = new Set([
  'todo_list',
  'todo_get',
  'todo_search',
  'todo_stats',
  'todo_restore',
  'content_readBody',
  'content_history',
  'drawing_list',
  'drawing_read',
  // DSH 自带工具——读类工具经 host `tools/pre-execute` 监听器（path 校验）
  // 直通；越界会被 host 强制 return { kind: 'deny' }，不在 tier 表里管。
  'read',
  'read_image',
  'grep',
  'glob',
]);

export const NOTIFY_UNDO_TOOLS: ReadonlySet<string> = new Set([
  'todo_create',
  'todo_update',
  'content_writeBody',
  'drawing_save',
  'drawing_setThumb',
]);

export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'todo_delete',
  'drawing_delete',
  'content_restoreVersion',
  // DSH 自带工具——mutate 类由 host `tools/pre-execute` 监听器强制
  // { kind: 'ask' } 进入 approval/request 审批路径。tier 表只是声明性分类
  // （对应 OPENSPEC §ai-assistant Permission boundaries），实际强制由
  // dsh-runtime.ts 的 waterfall 监听器实现。
  'write',
  'edit',
  'bash',
  'pwsh',
]);

export type PermissionTier = 'auto' | 'notify-undo' | 'block';

/** Unknown tools default to block (the conservative tier). */
export function tierFor(tool: string): PermissionTier {
  if (SAFE_TOOLS.has(tool)) return 'auto';
  if (NOTIFY_UNDO_TOOLS.has(tool)) return 'notify-undo';
  if (DESTRUCTIVE_TOOLS.has(tool)) return 'block';
  return 'block';
}
