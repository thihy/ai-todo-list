// External SDK surface — exposes a typed JS API that other Node processes can
// import to drive the app from outside (CI, scripts, plugins).
//
// This is the in-process equivalent of the ACP transport: a programmatic
// handle to TODO + content + drawing ops that mirrors the IPC channels.

import type { TodoRepo } from '../db/todo-repo';
import type { MarkdownStore } from '../files/markdown';
import type { DrawingStore } from '../files/drawings';
import type {
  ContentVersionEntry,
  DrawingMeta,
  DrawingScene,
  SearchHit,
  Todo,
  TodoCreate,
  TodoFilter,
  TodoPatch,
  TodoStats,
} from '../../shared/todo-types';

export interface ThihySdk {
  todo: {
    list(filter?: TodoFilter): Todo[];
    get(id: string): Todo | null;
    create(input: TodoCreate): Todo;
    update(id: string, patch: TodoPatch): Todo;
    delete(id: string): void;
    restore(id: string): void;
    search(query: string, limit?: number): SearchHit[];
    stats(windowDays?: number): TodoStats;
  };
  content: {
    readBody(id: string): { markdown: string; version: number };
    writeBody(id: string, markdown: string, expectVersion?: number): { version: number; updatedAt: number };
    history(id: string): ContentVersionEntry[];
    restoreVersion(id: string, versionId: number): void;
  };
  drawing: {
    list(todoId: string): DrawingMeta[];
    read(id: string): { scene: DrawingScene; meta: DrawingMeta };
    save(todoId: string, scene: DrawingScene, id?: string, title?: string): DrawingMeta;
    delete(id: string): void;
  };
  version: string;
}

export function createSdk(deps: {
  repo: TodoRepo;
  md: MarkdownStore;
  drawings: DrawingStore;
}): ThihySdk {
  return {
    todo: {
      list: (filter = {}) => deps.repo.list(filter),
      get: (id) => deps.repo.get(id),
      create: (input) => {
        const t = deps.repo.create(input, deps.md.filePathFor('placeholder'));
        deps.md.writeBody(t.id, '');
        return deps.repo.get(t.id)!;
      },
      update: (id, patch) => deps.repo.update(id, patch),
      delete: (id) => deps.repo.delete(id),
      restore: (id) => deps.repo.restore(id),
      search: (query, limit) => deps.repo.search(query, limit ?? 50),
      stats: (windowDays) => deps.repo.stats(windowDays ?? 7),
    },
    content: {
      readBody: (id) => deps.md.readBody(id),
      writeBody: (id, markdown, expectVersion) => deps.md.writeBody(id, markdown, expectVersion),
      history: (id) => deps.md.history(id),
      restoreVersion: (id, versionId) => deps.md.restoreVersion(id, versionId),
    },
    drawing: {
      list: (todoId) => deps.drawings.list(todoId),
      read: (id) => deps.drawings.read(id) as { scene: DrawingScene; meta: DrawingMeta },
      save: (todoId, scene, id, title) => deps.drawings.save(todoId, scene, id, title),
      delete: (id) => deps.drawings.delete(id),
    },
    version: '0.1.0',
  };
}
