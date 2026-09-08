// DSH tool registry — maps our domain ops onto DSH tool calls.
// Tier classification per design.md §4: auto / notify-undo / block.

import type { DshContainer } from './types';
import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';

export const SAFE_TOOLS = new Set<string>([
  'todo.list',
  'todo.get',
  'todo.search',
  'todo.stats',
  'content.readBody',
  'content.history',
  'drawing.list',
  'drawing.read',
]);

export const NOTIFY_UNDO_TOOLS = new Set<string>([
  'todo.create',
  'todo.update',
  'content.writeBody',
  'drawing.save',
  'drawing.setThumb',
]);

export const DESTRUCTIVE_TOOLS = new Set<string>([
  'todo.delete',
  'drawing.delete',
  'content.restoreVersion',
  'settings.set',
]);

export type PermissionTier = 'auto' | 'notify-undo' | 'block';

export function tierFor(tool: string): PermissionTier {
  if (SAFE_TOOLS.has(tool)) return 'auto';
  if (NOTIFY_UNDO_TOOLS.has(tool)) return 'notify-undo';
  if (DESTRUCTIVE_TOOLS.has(tool)) return 'block';
  return 'block';
}

export interface ToolContext {
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
  send: (channel: string, payload: unknown) => void;
  invocationId: string;
}

export function registerDshTools(container: DshContainer, ctx: Omit<ToolContext, 'invocationId'>): void {
  const wrap = (name: string, fn: (args: unknown, c: ToolContext) => Promise<unknown>) => {
    container.registerTool?.(name, async (args: unknown) => {
      const sub = { ...ctx, invocationId: (args as { __inv?: string }).__inv ?? '' };
      try {
        const data = await fn(args, sub);
        ctx.send('ai:stream', { type: 'toolResult', invocationId: sub.invocationId, name, ok: true, data });
        return data;
      } catch (err) {
        const message = (err as Error).message;
        ctx.send('ai:stream', { type: 'toolResult', invocationId: sub.invocationId, name, ok: false, error: message });
        throw err;
      }
    });
  };

  wrap('todo.list', async (args, c) => c.repo.list((args as never) ?? {}));
  wrap('todo.get', async (args, c) => c.repo.get((args as { id: string }).id));
  wrap('todo.create', async (args, c) => {
    const todo = c.repo.create((args as never) ?? { title: '' }, c.md.filePathFor('placeholder'));
    c.md.writeBody(todo.id, '');
    return c.repo.get(todo.id);
  });
  wrap('todo.update', async (args, c) => {
    const { id, ...patch } = args as { id: string; [k: string]: unknown };
    return c.repo.update(id, patch as never);
  });
  wrap('todo.delete', async (args, c) => {
    c.repo.delete((args as { id: string }).id);
    return { ok: true };
  });
  wrap('todo.search', async (args, c) => {
    const { query, limit } = args as { query: string; limit?: number };
    return c.repo.search(query, limit ?? 20);
  });
  wrap('todo.stats', async (_args, c) => c.repo.stats(7));

  wrap('content.readBody', async (args, c) => c.md.readBody((args as { id: string }).id));
  wrap('content.writeBody', async (args, c) => {
    const { id, markdown } = args as { id: string; markdown: string };
    return c.md.writeBody(id, markdown);
  });
  wrap('content.history', async (args, c) => c.md.history((args as { id: string }).id));
  wrap('content.restoreVersion', async (args, c) => {
    const { id, versionId } = args as { id: string; versionId: number };
    c.md.restoreVersion(id, versionId);
    return { ok: true };
  });

  wrap('drawing.list', async (args, c) => c.drawings.list((args as { todoId: string }).todoId));
  wrap('drawing.read', async (args, c) => c.drawings.read((args as { id: string }).id));
  wrap('drawing.save', async (args, c) => {
    const { todoId, scene, id, title } = args as {
      todoId: string;
      scene: unknown;
      id?: string;
      title?: string;
    };
    return c.drawings.save(todoId, scene as never, id, title);
  });
  wrap('drawing.delete', async (args, c) => {
    c.drawings.delete((args as { id: string }).id);
    return { ok: true };
  });
  wrap('drawing.setThumb', async (args, c) => {
    const { id, dataUrl } = args as { id: string; dataUrl: string };
    c.drawings.setThumb(id, dataUrl);
    return { ok: true };
  });
}
