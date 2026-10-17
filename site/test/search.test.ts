import { describe, expect, test } from 'bun:test';
import { prepareIndex, type SearchEntry, search } from '../src/lib/search.js';

const raw: SearchEntry[] = [
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
const entries = prepareIndex(raw);

describe('search', () => {
  test('prepareIndex lowercases each entry once and keeps the original fields', () => {
    const [logging] = entries;
    expect(logging).toMatchObject(raw[0]!);
    expect(logging!.lower.title).toBe('logging');
    expect(logging!.lower.headings).toEqual(['redaction']);
    expect(logging!.lower.everywhere).toBe(
      'logging log through the injected logger. redaction jsonlogger writes one json object per line. redaction removes credentials.',
    );
  });

  test('heading excerpts keep the original case', () => {
    const hit = search(entries, 'redaction').find((r) => r.hash === 'redaction');
    expect(hit?.excerpt).toBe(
      'JsonLogger writes one JSON object per line. Redaction removes credentials.',
    );
  });

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
