// Hash router. Routes per ui-wireframe.md §1.

export type Route =
  | { name: 'home' }
  | { name: 'list'; filter: ListFilter }
  | { name: 'todo'; id: string }
  | { name: 'todo-drawing'; id: string; drawingId?: string }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'ai' };

export type ListFilter =
  | { kind: 'all' }
  | { kind: 'today' }
  | { kind: 'next7' }
  | { kind: 'archived' }
  | { kind: 'project'; tag: string }
  | { kind: 'status'; status: string }
  | { kind: 'priority'; priority: string };

export function parseHash(hash: string): Route {
  // Strip '#' and an optional single leading slash so '#/settings' and
  // '#settings' both resolve. Without stripping the slash, '/settings'.split('/')
  // yields head='' and every non-list route silently falls back to 'home'
  // (which is why Settings / Stats / Inbox appeared to do nothing).
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return { name: 'home' };
  const [head, ...rest] = raw.split('/');
  switch (head) {
    case 'list':
      return { name: 'list', filter: parseFilter(rest.join('/')) };
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
  if (s === 'today') return { kind: 'today' };
  if (s === 'next7') return { kind: 'next7' };
  if (s === 'archived') return { kind: 'archived' };
  if (s.startsWith('project/')) return { kind: 'project', tag: s.slice('project/'.length) };
  if (s.startsWith('status/')) return { kind: 'status', status: s.slice('status/'.length) };
  if (s.startsWith('priority/')) return { kind: 'priority', priority: s.slice('priority/'.length) };
  return { kind: 'all' };
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'list':
      return `#/list/${filterToPath(r.filter)}`;
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
    case 'today':
      return 'today';
    case 'next7':
      return 'next7';
    case 'archived':
      return 'archived';
    case 'project':
      return `project/${f.tag}`;
    case 'status':
      return `status/${f.status}`;
    case 'priority':
      return `priority/${f.priority}`;
  }
}