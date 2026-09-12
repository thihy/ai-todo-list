// Router: parseHash / routeToHash round-trip, focused on the sort query
// (?sort=alpha|created|due|priority) that the 排序 button writes into the
// #/list/<path>?sort=<key> hash. The sort query is optional and defaults to
// 字母顺序 (alpha); parseHash must map a missing query back to the default,
// reject unknown values, and routeToHash must OMIT the query for the default
// so URLs stay clean.

import { describe, it, expect } from 'vitest';
import { parseHash, routeToHash, DEFAULT_SORT, SORT_KEYS } from '../../src/renderer/router';

describe('router sort deep-link', () => {
  it('defaults to alpha when no ?sort= query is present', () => {
    const r = parseHash('#/list/status/next');
    expect(r).toMatchObject({ name: 'list' });
    expect((r as { sort: string }).sort).toBe(DEFAULT_SORT);
    expect((r as { sort: string }).sort).toBe('alpha');
  });

  it('parses a ?sort= query on a list route', () => {
    const r = parseHash('#/list/status/next?sort=due');
    expect((r as { sort: string }).sort).toBe('due');
  });

  it('parses ?sort= on the bare 全部 list route (#/list/?sort=)', () => {
    const r = parseHash('#/list/?sort=priority');
    expect((r as { sort: string }).sort).toBe('priority');
  });

  it('rejects an unknown sort value and falls back to the default', () => {
    const r = parseHash('#/list?sort=bogus');
    expect((r as { sort: string }).sort).toBe(DEFAULT_SORT);
  });

  it('routeToHash omits ?sort= for the default so URLs stay clean', () => {
    const h = routeToHash({ name: 'list', filter: { kind: 'all' }, sort: 'alpha' });
    expect(h).toBe('#/list/');
    expect(h).not.toContain('?sort=');
  });

  it('routeToHash emits ?sort=<key> for a non-default sort', () => {
    const h = routeToHash({ name: 'list', filter: { kind: 'status', status: 'next' }, sort: 'created' });
    expect(h).toBe('#/list/status/next?sort=created');
  });

  it('round-trips every SortKey through parseHash(routeToHash(...))', () => {
    for (const sort of SORT_KEYS) {
      const hash = routeToHash({ name: 'list', filter: { kind: 'all' }, sort });
      const back = parseHash(hash) as { sort: string };
      expect(back.sort).toBe(sort);
    }
  });

  it('keeps the filter path intact when a sort query is present', () => {
    // A status filter survives the ?sort split.
    const r = parseHash('#/list/status/next?sort=due') as { filter: { kind: string; status?: string }; sort: string };
    expect(r.filter).toMatchObject({ kind: 'status', status: 'next' });
    expect(r.sort).toBe('due');
  });

  it('parses the 已删除 recovery view', () => {
    const r = parseHash('#/list/deleted');
    expect(r.filter).toMatchObject({ kind: 'deleted' });
    const h = routeToHash({ name: 'list', filter: { kind: 'deleted' }, sort: 'alpha' });
    expect(h).toBe('#/list/deleted');
  });
});

describe('router non-list routes unaffected by sort', () => {
  it('home route has no sort field', () => {
    const r = parseHash('#/');
    expect(r.name).toBe('home');
    expect('sort' in r).toBe(false);
  });

  it('todo route carries the id and no sort', () => {
    const r = parseHash('#/todo/01ABC');
    expect(r).toMatchObject({ name: 'todo', id: '01ABC' });
  });
});
