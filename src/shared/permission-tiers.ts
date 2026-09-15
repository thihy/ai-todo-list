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
]);

export type PermissionTier = 'auto' | 'notify-undo' | 'block';

/** Unknown tools default to block (the conservative tier). */
export function tierFor(tool: string): PermissionTier {
  if (SAFE_TOOLS.has(tool)) return 'auto';
  if (NOTIFY_UNDO_TOOLS.has(tool)) return 'notify-undo';
  if (DESTRUCTIVE_TOOLS.has(tool)) return 'block';
  return 'block';
}
