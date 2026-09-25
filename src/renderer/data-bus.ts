// Renderer-side data invalidation bus. The main process runs AI tools (and
// future background mutations) directly on the DB; those changes would
// otherwise not reach the renderer's data hooks until the user navigates.
// Main pushes `app:data-changed` { scope }; App.tsx bridges it here via
// emitDataChanged, and any hook using useDataVersion(scopes) re-fetches.
//
// Implementation: a per-scope monotonic counter + useSyncExternalStore, so
// only the hooks whose scopes actually changed re-run.

import { useSyncExternalStore } from 'react';
import type { DataScope } from '../shared/todo-list-api';

const SCOPES: readonly DataScope[] = ['todos', 'content', 'drawings', 'conversations', 'tags', 'memos'];
const scopeVersions = new Map<DataScope, number>(SCOPES.map((s) => [s, 0]));
const subscribers = new Set<() => void>();

/** Called from the App-level app:data-changed listener. */
export function emitDataChanged(scope: DataScope): void {
  scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1);
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(scopes: readonly DataScope[]): number {
  let sum = 0;
  for (const s of scopes) sum += scopeVersions.get(s) ?? 0;
  return sum;
}

/** Re-render (return a new number) whenever any of `scopes` changes. Add the
 *  returned value to a data-fetch effect's deps to auto-refresh. */
export function useDataVersion(scopes: readonly DataScope[]): number {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(scopes),
    () => getSnapshot(scopes),
  );
}
