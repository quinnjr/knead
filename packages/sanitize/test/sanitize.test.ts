import { describe, expect, test } from 'bun:test';
import { POLICIES, sanitize } from '../src/index.js';

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
    expect(sanitize('<img src="mailto:a@b.example">', 'rich')).toBe('<img />');
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
