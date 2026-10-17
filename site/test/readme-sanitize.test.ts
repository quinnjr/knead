import { expect, test } from 'bun:test';
import * as readme from '../snippets/readme/sanitize.js';

test('README quick start: basic and strict presets', () => {
  expect(readme.comment).toBe(
    '<p>Read <a rel="noopener noreferrer">this</a> and <a href="https://example.com" rel="noopener noreferrer">that</a></p>',
  );
  expect(readme.title).toBe('Release notes');
});
