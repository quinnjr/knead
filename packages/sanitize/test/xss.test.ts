import { describe, expect, test } from 'bun:test';
import { type PresetName, sanitize } from '../src/index.js';
import { XSS_PAYLOADS } from './fixtures/xss-payloads.js';

const DANGEROUS_TAG =
  /<\s*\/?\s*(script|iframe|object|embed|svg|math|style|meta|link|base|form|input|details|body|noscript|xmp|noembed|noframes|plaintext|title|frame|frameset|applet|portal)\b/i;
const EVENT_HANDLER = /\son[a-z]+\s*=/i;
const URL_ATTR = '(href|src|cite|action|background|poster|data|formaction|ping)';
const DANGEROUS_URL = new RegExp(
  `${URL_ATTR}\\s*=\\s*["']?\\s*(javascript|vbscript|data|file|ftp|blob):`,
  'i',
);
const CLOBBERING = /\s(id|name)\s*=/i;
const PROTOCOL_RELATIVE = /(href|src)\s*=\s*["']?\s*\/\//i;
const STYLE_ATTR = /\sstyle\s*=/i;

describe.each(['strict', 'basic', 'rich'] as PresetName[])(
  '%s policy neutralizes the XSS corpus',
  (preset) => {
    test.each(XSS_PAYLOADS.map((p, i) => [i, p] as const))('payload #%d', (_i, payload) => {
      const out = sanitize(payload, preset);
      // Escaped text (&lt;img onerror=…&gt;) is harmless; inspect only real tags in the output.
      expect(out).not.toMatch(/<(?![a-z/])/i);
      for (const tag of out.match(/<[^>]*>/g) ?? []) {
        expect(tag).not.toMatch(DANGEROUS_TAG);
        expect(tag).not.toMatch(EVENT_HANDLER);
        expect(tag).not.toMatch(DANGEROUS_URL);
        expect(tag).not.toMatch(PROTOCOL_RELATIVE);
        expect(tag).not.toMatch(STYLE_ATTR);
        expect(tag).not.toMatch(CLOBBERING);
      }
    });
  },
);

describe('assertion helpers are not vacuous', () => {
  test('flag at least 80% of raw, unsanitized payloads', () => {
    const flagged = XSS_PAYLOADS.filter((raw) => {
      if (/<(?![a-z/])/i.test(raw)) return true;
      return (raw.match(/<[^>]*>/g) ?? []).some(
        (tag) =>
          DANGEROUS_TAG.test(tag) ||
          EVENT_HANDLER.test(tag) ||
          DANGEROUS_URL.test(tag) ||
          PROTOCOL_RELATIVE.test(tag) ||
          STYLE_ATTR.test(tag) ||
          CLOBBERING.test(tag),
      );
    });
    expect(flagged.length / XSS_PAYLOADS.length).toBeGreaterThanOrEqual(0.8);
  });
});
