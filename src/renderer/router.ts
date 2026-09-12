// Hash router. Routes per ui-wireframe.md §1.

export type SortKey = 'alpha' | 'created' | 'due' | 'priority';
export const SORT_KEYS: readonly SortKey[] = ['alpha', 'created', 'due', 'priority'];
export const DEFAULT_SORT: SortKey = 'alpha';

export type Route =
  | { name: 'home' }
  | { name: 'list'; filter: ListFilter; sort: SortKey }
  | { name: 'todo'; id: string }
  | { name: 'todo-drawing'; id: string; drawingId?: string }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'ai' };

export type ListFilter =
  | { kind: 'all' }
  | { kind: 'archived' }
  | { kind: 'deleted' }
  | { kind: 'status'; status: string }
  | { kind: 'priority'; priority: string };

export function parseHash(hash: string): Route {
  // Strip '#' and an optional single leading slash so '#/settings' and
  // '#settings' both resolve. Without stripping the slash, '/settings'.split('/')
  // yields head='' and every non-list route silently falls back to 'home'
  // (which is why Settings / Stats / Inbox appeared to do nothing).
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return { name: 'home' };
  // Split off a '?sort=...' query before path-segment splitting so a sort
  // query on a list route doesn't leak into the filter path. Only the
  // FIRST '?' splits; the rest stays in the query.
  const qIdx = raw.indexOf('?');
  const pathPart = qIdx < 0 ? raw : raw.slice(0, qIdx);
  const queryPart = qIdx < 0 ? '' : raw.slice(qIdx + 1);
  const [head, ...rest] = pathPart.split('/');
  switch (head) {
    case 'list':
      return { name: 'list', filter: parseFilter(rest.join('/')), sort: parseSort(queryPart) };
    case 'todo': {
      const [id, sub, subId] = rest;
      if (sub === 'drawing') {
        return { name: 'todo-drawing', id, drawingId: subId };
      }
      return { name: 'todo', id };
    }
    case 'settings':
      return { name: 'settings' };
    case 'stats':
      return { name: 'stats' };
    case 'ai':
      return { name: 'ai' };
    default:
      return { name: 'home' };
  }
}

function parseFilter(s: string): ListFilter {
  if (!s) return { kind: 'all' };
  if (s === 'archived') return { kind: 'archived' };
  if (s === 'deleted') return { kind: 'deleted' };
  if (s.startsWith('status/')) return { kind: 'status', status: s.slice('status/'.length) };
  if (s.startsWith('priority/')) return { kind: 'priority', priority: s.slice('priority/'.length) };
  // today / next7 used to be distinct filters; the double-section view
  // (今日待办 / 其他任务) replaces them, so any stale URL falls back to
  // the all view rather than 404-ing.
  return { kind: 'all' };
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'list': {
      const base = `#/list/${filterToPath(r.filter)}`;
      // Omit ?sort= for the default so URLs stay clean (the default is
      // implied). parseSort maps a missing query back to DEFAULT_SORT.
      return r.sort === DEFAULT_SORT ? base : `${base}?sort=${r.sort}`;
    }
    case 'todo':
      return `#/todo/${r.id}`;
    case 'todo-drawing':
      return r.drawingId ? `#/todo/${r.id}/drawing/${r.drawingId}` : `#/todo/${r.id}/drawing`;
    case 'settings':
      return '#/settings';
    case 'stats':
      return '#/stats';
    case 'ai':
      return '#/ai';
  }
}

function filterToPath(f: ListFilter): string {
  switch (f.kind) {
    case 'all':
      return '';
    case 'archived':
      return 'archived';
    case 'deleted':
      return 'deleted';
    case 'status':
      return `status/${f.status}`;
    case 'priority':
      return `priority/${f.priority}`;
    default:
      // Exhaustive — future filter kinds should land here.
      return '';
  }
}

function parseSort(query: string): SortKey {
  if (!query) return DEFAULT_SORT;
  const s = new URLSearchParams(query).get('sort');
  return (s && (SORT_KEYS as readonly string[]).includes(s)) ? (s as SortKey) : DEFAULT_SORT;
}