// App focus — the renderer pushes its "currently focused entity" here so the
// AI can read it via the `app.currentContext` DSH tool. This is the bridge
// between the renderer's UI state and the model's awareness of what's open.
//
// The focus is a *pointer*, not a permission: it tells the AI "this is what
// the user is looking at right now" so its answers are grounded in real
// context. Any actual writes still go through the domain tools (todo.* /
// content.* / drawing.*) which have their own permission tier.
//
// State lives on the module (singleton) because:
//  - the renderer is the only writer;
//  - the AI runtime (in main) is the only reader;
//  - main never spawns multiple BrowserWindows, so a per-window map would be
//    overkill — the most recent focus wins, which matches user expectation
//    (last-opened document is the one the AI should reference).
//
// Pure functions so this stays trivially testable.

import type { ULID } from '../shared/todo-types';

export type FocusKind =
  | { kind: 'document'; todoId: ULID; documentId: ULID; documentKind: string; documentTitle: string | null }
  | { kind: 'drawing'; todoId: ULID; drawingId: ULID; drawingTitle: string | null }
  | { kind: 'task'; todoId: ULID; taskTitle: string | null }
  | null;

let current: FocusKind = null;

export function getFocus(): FocusKind {
  return current;
}

/** Replace the focus pointer. Pass null to clear. The renderer pushes this on
 *  every selection change (tab switch, drawing select, fullscreen enter) so
 *  the AI's view of "what's open" matches the user's view without lag. */
export function setFocus(next: FocusKind): void {
  current = next;
}

/** Reset focus on app exit (test fixture hygiene). */
export function clearFocus(): void {
  current = null;
}