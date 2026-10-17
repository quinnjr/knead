import { describe, expect, test } from 'bun:test';
import { type SearchEntry, search } from '../src/lib/search.js';

const entries: SearchEntry[] = [
  {
    slug: 'guide/logging',
    title: 'Logging',
    description: 'Log through the injected LOGGER.',
    headings: [{ id: 'redaction', text: 'Redaction' }],
    text: 'JsonLogger writes one JSON object per line. Redaction removes credentials.',
  },
  {
    slug: 'guide/modules',
    title: 'Modules',
    description: 'Group providers and controllers.',
    headings: [{ id: 'global-modules', text: 'Global modules' }],
    text: 'A module can import other modules and export providers.',
  },
];

describe('search', () => {
  test('an empty query finds nothing', () => {
    expect(search(entries, '   ')).toEqual([]);
  });

  test('ranks a title match first', () => {
    expect(search(entries, 'logging')[0]).toMatchObject({
      slug: 'guide/logging',
      title: 'Logging',
    });
  });

  test('returns heading results with their fragment', () => {
    const hit = search(entries, 'global').find((r) => r.hash);
    expect(hit).toMatchObject({
      slug: 'guide/modules',
      hash: 'global-modules',
      context: 'Modules',
    });
  });

  test('every term must occur on the page', () => {
    expect(search(entries, 'module credentials')).toEqual([]);
    expect(search(entries, 'json credentials').map((r) => r.slug)).toEqual(['guide/logging']);
  });

  test('is case-insensitive and keeps symbol names whole', () => {
    expect(search(entries, 'JSONLOGGER').map((r) => r.slug)).toEqual(['guide/logging']);
    expect(search(entries, '@knead-js/nothing')).toEqual([]);
  });
});
