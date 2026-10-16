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
      allowedSchemes: ['https', 'ftp', 'mailto'],
      extraSchemes: ['ftp'],
    };
    expect(sanitize('<img src="ftp://x.example/a.png">', policy)).toContain('src="ftp:');
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
  test('rejects attribute globs that sanitize-html would expand to on* handlers', () => {
    for (const attrs of [{ b: ['*'] }, { '*': ['o*'] }, { p: ['data-*'] }, { '*': ['*'] }]) {
      expect(() => sanitize('x', bad({ allowedAttributes: attrs }))).toThrow(
        /attribute pattern .* cannot contain "\*"/,
      );
    }
  });
  test('glob bypasses no longer re-enable onclick', () => {
    expect(() =>
      sanitize(
        '<b onclick="alert(1)">x</b>',
        bad({ allowedTags: ['b'], allowedAttributes: { b: ['*'] } }),
      ),
    ).toThrow(TypeError);
  });
  test('rejects script-capable URL schemes, case-insensitively', () => {
    for (const scheme of ['javascript', 'vbscript', 'data', 'JavaScript', 'VBSCRIPT', 'Data']) {
      expect(() =>
        sanitize(
          'x',
          bad({
            allowedTags: ['a'],
            allowedAttributes: { a: ['href'] },
            allowedSchemes: ['https', scheme],
          }),
        ),
      ).toThrow(/scheme "\w+" cannot be allowed/);
    }
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
      sanitize('x', bad({ allowedTags: ['p'], allowedAttributes: { p: ['title'] } })),
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

describe('hardened policy checks', () => {
  const bad = (p: object) => ({ allowedAttributes: {}, allowedTags: [], ...p });

  test('raw-text, legacy and embedding tags cannot be allowed', () => {
    for (const tag of [
      'xmp',
      'noembed',
      'noframes',
      'plaintext',
      'title',
      'frame',
      'frameset',
      'applet',
      'portal',
    ]) {
      expect(() => sanitize('x', bad({ allowedTags: [tag] }))).toThrow(TypeError);
    }
  });

  test('id and name need allowClobberingAttributes: true', () => {
    for (const attr of ['id', 'name', 'ID']) {
      expect(() =>
        sanitize('x', bad({ allowedTags: ['a'], allowedAttributes: { a: [attr] } })),
      ).toThrow(/clobber/);
    }
    const policy = bad({
      allowedTags: ['h2'],
      allowedAttributes: { h2: ['id'] },
      allowClobberingAttributes: true,
    });
    expect(sanitize('<h2 id="intro">x</h2>', policy)).toBe('<h2 id="intro">x</h2>');
  });

  test('schemes are an allowlist: http, https, mailto, tel', () => {
    expect(sanitize('<a href="tel:+15551234">call</a>', 'basic')).toBe(
      '<a href="tel:+15551234" rel="noopener noreferrer">call</a>',
    );
    for (const href of ['ftp://x.example/', 'file:///etc/passwd', 'sms:123', 'intent://x']) {
      expect(sanitize(`<a href="${href}">x</a>`, 'basic')).toBe(
        '<a rel="noopener noreferrer">x</a>',
      );
    }
    expect(() =>
      sanitize(
        'x',
        bad({ allowedTags: ['a'], allowedAttributes: { a: ['href'] }, allowedSchemes: ['ftp'] }),
      ),
    ).toThrow(/extraSchemes/);
  });

  test('extraSchemes extends the allowlist, but never with script-capable schemes', () => {
    const policy = bad({
      allowedTags: ['a'],
      allowedAttributes: { a: ['href'] },
      extraSchemes: ['ftp'],
    });
    expect(sanitize('<a href="ftp://x.example/">f</a>', policy)).toBe(
      '<a href="ftp://x.example/" rel="noopener noreferrer">f</a>',
    );
    expect(sanitize('<a href="https://x.example/">h</a>', policy)).toContain('href="https:');
    for (const scheme of ['javascript', 'Data', 'vbscript', 'not a scheme']) {
      expect(() => sanitize('x', bad({ extraSchemes: [scheme] }))).toThrow(TypeError);
    }
  });

  test('schemes are checked on every URL attribute, not just href and src', () => {
    const policy = bad({
      allowedTags: ['blockquote', 'q', 'del', 'ins'],
      allowedAttributes: { blockquote: ['cite'], q: ['cite'], del: ['cite'], ins: ['cite'] },
    });
    expect(sanitize('<blockquote cite="javascript:alert(1)">x</blockquote>', policy)).toBe(
      '<blockquote>x</blockquote>',
    );
    expect(sanitize('<q cite="https://example.com">x</q>', policy)).toBe(
      '<q cite="https://example.com">x</q>',
    );
  });
});
