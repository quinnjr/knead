import { describe, expect, test } from 'bun:test';
import { POLICIES, sanitize, sanitizedHtml } from '../src/index.js';

describe('presets', () => {
  test('strict keeps text only and drops script contents', () => {
    expect(sanitize('<b>Hi</b> <script>alert(1)</script>there', 'strict')).toBe('Hi there');
  });

  test('basic keeps inline formatting and links, forcing rel', () => {
    expect(
      sanitize('<p><strong>a</strong> <a href="https://x.example" target="_blank">l</a></p>'),
    ).toBe('<p><strong>a</strong> <a href="https://x.example" rel="noopener noreferrer">l</a></p>');
    expect(sanitize('<h1>title</h1><img src="https://x.example/a.png">', 'basic')).toBe('title');
  });

  test('rich adds block elements and images with http(s) sources only', () => {
    expect(
      sanitize('<h2>t</h2><ul><li>i</li></ul><img src="https://x.example/a.png" alt="a">', 'rich'),
    ).toBe('<h2>t</h2><ul><li>i</li></ul><img src="https://x.example/a.png" alt="a" />');
    expect(sanitize('<img src="mailto:a@b.example">', 'rich')).toBe('');
  });

  test('mailto links are allowed; custom policies work', () => {
    expect(sanitize('<a href="mailto:a@b.example">m</a>')).toContain('href="mailto:a@b.example"');
    expect(sanitize('<em>e</em><i>i</i>', { allowedTags: ['em'], allowedAttributes: {} })).toBe(
      '<em>e</em>i',
    );
  });

  test('policies are frozen data', () => {
    expect(POLICIES.basic.allowedTags).toContain('a');
    expect(Object.isFrozen(POLICIES.basic)).toBe(true);
  });
});

describe('deep-frozen presets', () => {
  test('nested arrays and records are frozen and immutable', () => {
    const frozen = [
      POLICIES.basic.allowedTags,
      POLICIES.basic.allowedAttributes,
      POLICIES.basic.allowedAttributes.a,
      POLICIES.rich.allowedAttributes.img,
      POLICIES.strict.allowedTags,
    ];
    for (const f of frozen) expect(Object.isFrozen(f)).toBe(true);
    expect(() => (POLICIES.basic.allowedTags as string[]).push('iframe')).toThrow(TypeError);
    expect(() => (POLICIES.basic.allowedAttributes.a as string[]).push('onclick')).toThrow(
      TypeError,
    );
    expect(POLICIES.basic.allowedTags).not.toContain('iframe');
  });
});

describe('img schemes', () => {
  test('custom allowedSchemes apply to img, minus mailto', () => {
    const policy = {
      allowedTags: ['img'],
      allowedAttributes: { img: ['src'] },
      allowedSchemes: ['https', 'data', 'mailto'],
    };
    expect(sanitize('<img src="data:image/png;base64,AAAA">', policy)).toContain('src="data:');
    expect(sanitize('<img src="mailto:a@b.example">', policy)).toBe('');
    expect(sanitize('<img src="http://x.example/a.png">', policy)).toBe('');
  });

  test('img without src is dropped', () => {
    expect(sanitize('<img alt="a">', 'rich')).toBe('');
    expect(sanitize('<img src="javascript:alert(1)" alt="a">', 'rich')).toBe('');
  });
});

describe('custom policy guard', () => {
  const bad = (p: object) => ({ allowedAttributes: {}, allowedTags: [], ...p });
  test('rejects dangerous tags', () => {
    for (const tag of ['script', 'style', 'iframe', 'svg', 'math', 'form', 'template', 'button']) {
      expect(() => sanitize('x', bad({ allowedTags: ['p', tag] }))).toThrow(TypeError);
    }
  });
  test('rejects dangerous attributes on any tag', () => {
    for (const attr of ['onclick', 'onerror', 'style', 'srcdoc', 'formaction']) {
      expect(() => sanitize('x', bad({ allowedAttributes: { p: [attr] } }))).toThrow(TypeError);
    }
  });
  test('rejects uppercase names', () => {
    expect(() => sanitize('x', bad({ allowedTags: ['SCRIPT'] }))).toThrow(TypeError);
    expect(() => sanitize('x', bad({ allowedAttributes: { p: ['ONCLICK'] } }))).toThrow(TypeError);
  });
  test('catches a policy mutated after first use', () => {
    const tags = ['p'];
    const policy = { allowedTags: tags, allowedAttributes: {} };
    sanitize('<p>x</p>', policy);
    tags.push('script');
    expect(() => sanitize('<script>1</script>', policy)).toThrow(TypeError);
  });
  test('accepts safe policies', () => {
    expect(() =>
      sanitize('x', bad({ allowedTags: ['p'], allowedAttributes: { p: ['id'] } })),
    ).not.toThrow();
  });
  test('sanitizedHtml validates eagerly', () => {
    const inner = {
      '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) },
    } as never;
    expect(() => sanitizedHtml(inner, bad({ allowedTags: ['script'] }))).toThrow(TypeError);
  });
});

describe('legitimate content survives', () => {
  const cases: [string, string][] = [
    ['<p onclick="alert(1)">click</p>', '<p>click</p>'],
    ['<a href="/docs">d</a>', '<a href="/docs" rel="noopener noreferrer">d</a>'],
    ['<a href="#top">t</a>', '<a href="#top" rel="noopener noreferrer">t</a>'],
    ['<a href="/path?q=1">q</a>', '<a href="/path?q=1" rel="noopener noreferrer">q</a>'],
    ['a < b && c > d', 'a &lt; b &amp;&amp; c &gt; d'],
  ];
  test.each(cases)('%s', (input, expected) => {
    expect(sanitize(input, 'basic')).toBe(expected);
  });
});
