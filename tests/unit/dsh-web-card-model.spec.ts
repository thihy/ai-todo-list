import { describe, expect, it } from 'vitest';
import { webCardModelFromMeta } from '../../src/renderer/dsh/ui-tool/tool/models/web-card-model';

describe('webCardModelFromMeta', () => {
  it('projects valid DSH web_search metadata to a WebBlock model', () => {
    expect(webCardModelFromMeta(
      'web_search',
      { queries: ['DSH components'] },
      {
        answer: 'A short answer',
        sources: [{ url: 'https://example.com/dsh', title: 'DSH', snippet: 'Components' }],
        truncated: false,
      },
    )).toEqual({
      kind: 'search',
      answer: 'A short answer',
      sources: [{ url: 'https://example.com/dsh', title: 'DSH', snippet: 'Components' }],
      truncated: false,
    });
  });

  it('projects valid DSH web_fetch metadata to a WebBlock model', () => {
    expect(webCardModelFromMeta(
      'web_fetch',
      { url: 'https://example.com/page' },
      { url: 'https://example.com/page', statusCode: 200, truncated: true },
    )).toEqual({
      kind: 'fetch',
      url: 'https://example.com/page',
      statusCode: 200,
      truncated: true,
    });
  });

  it('falls back safely for malformed or failed metadata', () => {
    expect(webCardModelFromMeta('web_search', { queries: [] }, { sources: [], truncated: false })).toBeNull();
    expect(webCardModelFromMeta('web_fetch', { url: 'https://example.com' }, { statusCode: 200 }, true)).toBeNull();
  });
});
